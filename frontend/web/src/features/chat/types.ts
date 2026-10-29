import type { AvatarTone } from "@/components/kit/kit";

/**
 * 聊天领域类型。
 *
 * 前半是后端 DTO（schema 未建模，字段按控制器/服务层实际返回断言），
 * 后半是渲染层视图模型。实时通道推来的消息与 REST 拉到的消息同构，
 * 两端共用同一份 DTO。
 */

/* ------------------------------------------------------------------ */
/* 后端 DTO                                                            */
/* ------------------------------------------------------------------ */

/** GET /api/v1/rooms 的房间项（room_controller.list_rooms）。 */
export interface RoomDto {
  id: string;
  repository_id: string | null;
  name: string;
  topic: string | null;
  is_active: boolean;
  created_at: string | null;
}

/** 房间消息项（ChatService._format_message）。 */
export interface RoomMessageDto {
  id: string;
  room_id: string;
  sender_id: string;
  sender_username: string;
  message_type: string;
  content: string;
  reply_to: string | null;
  edited_at: string | null;
  created_at: string | null;
}

/** GET /api/v1/rooms/{room_id}/messages 的分页响应（ChatService.get_messages）。 */
export interface MessagesPage {
  messages: RoomMessageDto[];
  has_more: boolean;
  next_before: string | null;
}

/** GET /api/v1/rooms/unread 的计数项（ChatService.get_unread_counts）。 */
export interface UnreadDto {
  room_id: string;
  unread_count: number;
}

/** GET /api/v1/rooms/{room_id}/members 的成员项（RoomService.get_members）。 */
export interface RoomMemberDto {
  id: string;
  room_id: string;
  user_id: string;
  username: string;
  role: string;
  joined_at: string | null;
  is_muted: boolean;
  is_bot: boolean;
}

/** GET /api/v1/dm 的私聊项（RoomService.list_dm_rooms + 未读补充）。 */
export interface DmRoomDto {
  room_id: string;
  room_name: string;
  room_type: string;
  peer_user_id: string;
  peer_username: string;
  created_at: string | null;
  unread_count: number;
}

/* ------------------------------------------------------------------ */
/* 频道侧栏                                                            */
/* ------------------------------------------------------------------ */

export interface ChatRoom {
  /** REST: GET /api/v1/rooms 的房间 id。 */
  id: string;
  name: string;
  unread?: number;
  active?: boolean;
}

export interface ChatRoomGroup {
  repo: string;
  /** 含当前仓库（或选中房间）的分组在侧栏高亮。 */
  active?: boolean;
  rooms: ChatRoom[];
}

/* ------------------------------------------------------------------ */
/* 消息流                                                              */
/* ------------------------------------------------------------------ */

export interface ChatMessage {
  id: string;
  author: string;
  initials: string;
  tone: AvatarTone;
  /** Agent 身份：机器人头像 + 琥珀消息体。 */
  bot?: boolean;
  /** 当前用户自己的消息。 */
  me?: boolean;
  time: string;
  /** Markdown 原文；@kustos-agent 提及由页面高亮。 */
  body: string;
}
