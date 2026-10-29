import { useCallback, useEffect, useRef, useState } from "react";

import { getAccessToken } from "@/lib/api/client";
import { WsClient, wsPath, type WsStatus } from "@/lib/realtime/ws-client";

/**
 * 房间实时通道。
 *
 * 把 WebSocket 上的房间订阅、消息帧、输入指示与在线状态收敛成一个 hook：
 * 页面只消费状态与发送函数，不直接碰连接生命周期。连接按房间复用，
 * 断线重连后自动重新订阅（服务端的房间与 presence 都挂在连接上）。
 */

/** 服务端推来的一帧数据。 */
export interface RoomChannelEvent {
  type: string;
  [key: string]: unknown;
}

/** 在线用户（presence_list 的 users 项 / presence_join 的发送者）。 */
export interface PresenceUser {
  user_id: string;
  username: string;
}

/** idle = 未选房间或会话未就绪；其余沿用连接状态。 */
export type RoomChannelStatus = "idle" | WsStatus;

export interface RoomChannel {
  status: RoomChannelStatus;
  online: PresenceUser[];
  typing: string[];
  /** 发送消息；连接未就绪或内容为空时返回 false。 */
  sendMessage: (content: string) => boolean;
  /** 给消息加/取消表情回应；连接未就绪时返回 false。 */
  sendReaction: (messageId: string, emoji: string, add: boolean) => boolean;
  /** 上报「正在输入」；静默一段时间后自动补发停止帧。 */
  notifyTyping: () => void;
}

/** 停止输入多久后补发 is_typing=false。 */
const TYPING_IDLE_MS = 3000;

/** 对端多久没再上报就本地清掉指示（兜底丢帧）。 */
const TYPING_EXPIRE_MS = 4000;

/**
 * 建立并维护当前房间的实时通道。
 *
 * @param roomId 房间 ID；为空时不建连，状态为 idle
 * @param onEvent 除 presence / typing 外的业务帧回调（消息、错误等）
 * @returns 连接状态、在线用户、输入指示与发送函数
 */
export function useRoomChannel(
  roomId: string | null,
  onEvent: (event: RoomChannelEvent) => void,
): RoomChannel {
  const [status, setStatus] = useState<RoomChannelStatus>("idle");
  const [online, setOnline] = useState<PresenceUser[]>([]);
  const [typing, setTyping] = useState<string[]>([]);

  const clientRef = useRef<WsClient | null>(null);
  // 回调存在 ref 里：页面每次渲染都会传新函数，放进依赖会让连接反复重建
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  const typingTimers = useRef(new Map<string, number>());
  // user_id → username：状态列表按用户名展示，按 user_id 才能精确清除
  const typingNames = useRef(new Map<string, string>());
  const typingResetTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!roomId || !getAccessToken()) {
      setStatus("idle");
      return;
    }

    // 切换房间时旧房间的在线与输入状态一律作废
    setOnline([]);
    setTyping([]);

    // 清理函数里要按 effect 建立时的引用清理，不能读可能已换绑的 ref
    const timers = typingTimers.current;
    const names = typingNames.current;

    const forgetTyping = (userId: string) => {
      const timer = timers.get(userId);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timers.delete(userId);
      }
      const name = names.get(userId);
      names.delete(userId);
      if (name) setTyping((prev) => prev.filter((item) => item !== name));
    };

    const markTyping = (userId: string, username: string, active: boolean) => {
      if (!userId) return;
      const existing = timers.get(userId);
      if (existing !== undefined) {
        window.clearTimeout(existing);
        timers.delete(userId);
      }
      if (!active) {
        const name = names.get(userId) ?? username;
        names.delete(userId);
        setTyping((prev) => prev.filter((item) => item !== name));
        return;
      }
      names.set(userId, username);
      setTyping((prev) => (prev.includes(username) ? prev : [...prev, username]));
      const timer = window.setTimeout(() => forgetTyping(userId), TYPING_EXPIRE_MS);
      timers.set(userId, timer);
    };

    const handleFrame = (frame: RoomChannelEvent) => {
      switch (frame.type) {
        case "presence_list":
          setOnline(Array.isArray(frame.users) ? (frame.users as PresenceUser[]) : []);
          break;
        case "presence_join": {
          const user: PresenceUser = {
            user_id: String(frame.user_id ?? ""),
            username: String(frame.username ?? ""),
          };
          if (!user.user_id) break;
          setOnline((prev) =>
            prev.some((item) => item.user_id === user.user_id) ? prev : [...prev, user],
          );
          break;
        }
        case "presence_leave": {
          const userId = String(frame.user_id ?? "");
          setOnline((prev) => prev.filter((item) => item.user_id !== userId));
          break;
        }
        case "chat_typing":
          markTyping(
            String(frame.user_id ?? ""),
            String(frame.username ?? ""),
            Boolean(frame.is_typing),
          );
          break;
        default:
          break;
      }
      handlerRef.current(frame);
    };

    const client = new WsClient({
      path: wsPath("/"),
      // 传函数而不是字符串：访问令牌会轮换，重连时必须用新的
      token: getAccessToken,
      onStatus: setStatus,
      onOpen: (send) => {
        // 服务端按连接维护订阅，每次建连（含重连）都要重新加入房间
        send({ type: "room_join", room_id: roomId });
        send({ type: "presence_list", room_id: roomId });
      },
      onMessage: (data) => {
        if (data && typeof data === "object") handleFrame(data as RoomChannelEvent);
      },
    });

    clientRef.current = client;
    client.connect();

    return () => {
      client.close();
      clientRef.current = null;
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
      names.clear();
      if (typingResetTimer.current !== null) {
        window.clearTimeout(typingResetTimer.current);
        typingResetTimer.current = null;
      }
      setStatus("idle");
      setOnline([]);
      setTyping([]);
    };
  }, [roomId]);

  const sendMessage = useCallback(
    (content: string): boolean => {
      const client = clientRef.current;
      const text = content.trim();
      if (!client || client.readyState !== WebSocket.OPEN || !text) return false;
      client.send({ type: "chat_message", room_id: roomId, content: text });
      // 自己的消息同样要结束输入指示，否则对端会一直看到「正在输入」
      if (typingResetTimer.current !== null) {
        window.clearTimeout(typingResetTimer.current);
        typingResetTimer.current = null;
      }
      client.send({ type: "chat_typing", room_id: roomId, is_typing: false });
      return true;
    },
    [roomId],
  );

  const sendReaction = useCallback(
    (messageId: string, emoji: string, add: boolean): boolean => {
      const client = clientRef.current;
      if (!client || client.readyState !== WebSocket.OPEN || !roomId || !messageId || !emoji) {
        return false;
      }
      // 服务端按 action 增删，回帧里带完整消息（含新的 reactions 聚合）
      client.send({ type: "chat_reaction", room_id: roomId, message_id: messageId, emoji, add });
      return true;
    },
    [roomId],
  );

  const notifyTyping = useCallback(() => {    const client = clientRef.current;
    if (!client || client.readyState !== WebSocket.OPEN || !roomId) return;
    client.send({ type: "chat_typing", room_id: roomId, is_typing: true });
    if (typingResetTimer.current !== null) window.clearTimeout(typingResetTimer.current);
    typingResetTimer.current = window.setTimeout(() => {
      typingResetTimer.current = null;
      client.send({ type: "chat_typing", room_id: roomId, is_typing: false });
    }, TYPING_IDLE_MS);
  }, [roomId]);

  return { status, online, typing, sendMessage, sendReaction, notifyTyping };
}
