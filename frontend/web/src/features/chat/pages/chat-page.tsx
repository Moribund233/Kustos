import { AtSign, FileText, Paperclip, Pin, Search, Send, Settings, Smile, Users, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { currentLocale } from "@/lib/i18n";
import { useSearchParams } from "react-router";
import { toast } from "sonner";

import { Lamp, RailBlock, Stage, ToneAvatar, type AvatarTone } from "@/components/kit/kit";
import { Skeleton } from "@/components/ui/skeleton";
import { StartDmButton } from "@/features/chat/components/start-dm-dialog";
import { RoomSettingsDialog } from "@/features/chat/components/room-settings-dialog";
import { mergeMessage } from "@/features/chat/lib/messages";
import type {
  ChatMessage,
  ChatRoomGroup,
  DmRoomDto,
  MessagesPage,
  RoomDto,
  RoomMemberDto,
  RoomMessageDto,
  UnreadDto,
} from "@/features/chat/types";
import {
  useRoomChannel,
  type PresenceUser,
  type RoomChannelEvent,
  type RoomChannelStatus,
} from "@/features/chat/use-room-channel";
import { api, getAccessToken } from "@/lib/api/client";
import { useApiMutation, useApiQuery } from "@/lib/api/hooks";
import { Markdown } from "@/lib/markdown/markdown";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth-store";
import { useRepoStore } from "@/stores/repo-store";
import { useUiStore } from "@/stores/ui-store";

/** 每页拉取的消息条数（后端默认页大，取近一页足够首屏）。 */
const MESSAGE_PAGE_SIZE = 30;

/** 实时通道状态文案；idle 表示尚未选中房间或会话未就绪。 */
const CHANNEL_STATUS_KEY: Record<RoomChannelStatus, string> = {
  idle: "chat.channelIdle",
  connecting: "chat.channelConnecting",
  open: "chat.channelOpen",
  closed: "chat.channelClosed",
  error: "chat.channelError",
};

const AVATAR_TONES: AvatarTone[] = ["amber", "sage", "sky", "rose", "slate"];

/** 后端只有 username、没有头像元数据：从用户名推导头像首字母。 */
function initialsOf(username: string): string {
  const parts = username.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((part) => part.charAt(0).toUpperCase());
  return letters.join("") || "?";
}

/** 同一用户名恒定同一头像色调（哈希取模）。 */
function toneFor(username: string): AvatarTone {
  let hash = 0;
  for (const char of username) hash = (hash * 31 + char.charCodeAt(0)) % 9973;
  return AVATAR_TONES[hash % AVATAR_TONES.length] ?? "slate";
}

/** created_at（ISO）→ 与原型一致的 HH:mm 展示。 */
function clockOf(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}


/**
 * 聊天页（原型 chat.html）。
 *
 * 数据源分两层：REST 提供房间、成员、历史消息与已读游标；实时通道
 * （WebSocket）提供新消息、输入指示与在线状态。两层写同一份 React Query
 * 缓存，因此页面不区分「刚推来的」和「刚拉到的」消息。
 */
export function ChatPage() {
  const { t } = useTranslation();
  const setCrumbs = useUiStore((state) => state.setCrumbs);
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const roomId = searchParams.get("room");
  const user = useAuthStore((state) => state.user);
  const currentRepo = useRepoStore((state) => state.current);
  const repos = useRepoStore((state) => state.repos);
  const listRef = useRef<HTMLDivElement | null>(null);

  // 房间列表：当前用户已加入的全部活跃仓库频道
  const { data: rooms, isLoading: loadingRooms } = useApiQuery<RoomDto[]>({
    queryKey: ["rooms"],
    queryFn: async () => {
      const res = await api.GET("/api/v1/rooms");
      return (res.data ?? []) as RoomDto[];
    },
  });

  // 未读计数：徽标数据源，切房间标记已读后失效刷新
  const { data: unread } = useApiQuery<UnreadDto[]>({
    queryKey: ["rooms", "unread"],
    queryFn: async () => {
      const res = await api.GET("/api/v1/rooms/unread");
      return (res.data ?? []) as UnreadDto[];
    },
  });

  // 当前仓库的房间：未加入时该端点按需补建/取，借它把当前仓库对上号并高亮分组
  const { data: repoRoom } = useApiQuery<RoomDto>({
    queryKey: ["rooms", "repo-room", currentRepo?.id ?? ""],
    enabled: Boolean(currentRepo),
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/room", {
        params: { path: { repo_id: currentRepo?.id ?? "" } },
      });
      return res.data as RoomDto;
    },
  });

  const roomList = useMemo(() => {
    const list = [...(rooms ?? [])];
    if (repoRoom && !list.some((item) => item.id === repoRoom.id)) list.unshift(repoRoom);
    return list;
  }, [rooms, repoRoom]);

  // 私聊会话是 room_type=dm 的房间，不在 /rooms 列表里，需单独取一次
  const { data: dms, isLoading: loadingDms } = useApiQuery<DmRoomDto[]>({
    queryKey: ["dm"],
    queryFn: async () => {
      const res = await api.GET("/api/v1/dm");
      return (res.data ?? []) as DmRoomDto[];
    },
  });

  /** 当前房间：先查频道列表，再回落到私聊（私聊的房间元数据由会话项拼出）。 */
  const room = useMemo<RoomDto | null>(() => {
    const channel = roomList.find((item) => item.id === roomId);
    if (channel) return channel;
    const dm = (dms ?? []).find((item) => item.room_id === roomId);
    if (!dm) return null;
    return {
      id: dm.room_id,
      repository_id: null,
      name: dm.peer_username,
      topic: null,
      is_active: true,
      created_at: dm.created_at,
    };
  }, [roomList, dms, roomId]);

  const isDm = Boolean(room && room.repository_id === null);

  // 未用 ?room= 选定时，默认进入当前仓库的房间（或第一个房间）
  useEffect(() => {
    const fallback = repoRoom ?? roomList[0];
    if (roomId || !fallback) return;
    setSearchParams({ room: fallback.id }, { replace: true });
  }, [roomId, roomList, repoRoom, setSearchParams]);

  // 房间内消息检索：q 走后端内容过滤，检索态下不做游标翻页
  const [searchOpen, setSearchOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(keyword.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  // 房间消息：取最近一页（倒序返回），渲染时转正序
  const { data: page, isLoading: loadingMessages } = useApiQuery<MessagesPage>({
    queryKey: ["messages", roomId ?? "", search],
    enabled: Boolean(roomId),
    queryFn: async () => {
      const res = await api.GET("/api/v1/rooms/{room_id}/messages", {
        params: {
          path: { room_id: roomId ?? "" },
          query: { limit: MESSAGE_PAGE_SIZE, ...(search ? { q: search } : {}) },
        },
      });
      return (res.data ?? { messages: [], has_more: false, next_before: null }) as MessagesPage;
    },
  });

  // 房间成员：右栏列表 + bot 消息的机器人身份判定
  const { data: members, isLoading: membersLoading } = useApiQuery<RoomMemberDto[]>({
    queryKey: ["members", roomId ?? ""],
    enabled: Boolean(roomId),
    queryFn: async () => {
      const res = await api.GET("/api/v1/rooms/{room_id}/members", {
        params: { path: { room_id: roomId ?? "" } },
      });
      return (res.data ?? []) as RoomMemberDto[];
    },
  });

  // 切房间即标记已读；成功后失效未读缓存让徽标归零
  const markRead = useApiMutation<void, string>(
    async (id) => {
      await api.POST("/api/v1/rooms/{room_id}/read", { params: { path: { room_id: id } } });
    },
    {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: ["rooms", "unread"] });
      },
    },
  );
  const { mutate: markRoomRead } = markRead;

  // 实时帧：消息写进同一份缓存，其余（presence / typing）由通道自身维护
  const handleRealtimeEvent = useCallback(
    (event: RoomChannelEvent) => {
      if (event.type === "chat_message" || event.type === "chat_message_ack" || event.type === "chat_reaction" || event.type === "chat_reaction_ack") {
        const incoming = event.message as RoomMessageDto | undefined;
        if (!incoming?.id || incoming.room_id !== roomId) return;
        // 只并入"未检索"的缓存：搜索结果是一次快照，不该被新消息改写
        queryClient.setQueryData<MessagesPage>(["messages", incoming.room_id, ""], (old) =>
          old ? mergeMessage(old, incoming) : old,
        );
        // 正在看的房间收到别人的消息：立即回执已读，避免徽标和列表打架
        if (event.type === "chat_message") markRoomRead(incoming.room_id);
        return;
      }
      if (event.type === "error") {
        toast.error(typeof event.error === "string" ? event.error : t("chat.channelErrorToast"));
      }
    },
    [queryClient, roomId, markRoomRead, t],
  );

  const channel = useRoomChannel(roomId, handleRealtimeEvent);

  useEffect(() => {
    if (roomId) markRoomRead(roomId);
  }, [roomId, markRoomRead]);

  // 换房间时退出检索态：搜索词属于上一个房间，带过去只会得出空结果
  useEffect(() => {
    setSearchOpen(false);
    setKeyword("");
    setSearch("");
  }, [roomId]);

  const toggleSearch = () => {
    setSearchOpen((open) => !open);
    setKeyword("");
    setSearch("");
  };

  useEffect(() => {
    setCrumbs(room ? [{ label: t("nav.chat") }, { label: `#${room.name}` }] : [{ label: t("nav.chat") }]);
  }, [setCrumbs, t, room]);

  const botUsernames = useMemo(
    () => new Set((members ?? []).filter((member) => member.is_bot).map((member) => member.username)),
    [members],
  );

  const messages: ChatMessage[] = useMemo(() => {
    const ascending = [...(page?.messages ?? [])].reverse();
    return ascending.map((message) => ({
      id: message.id,
      author: message.sender_username,
      initials: initialsOf(message.sender_username),
      tone: toneFor(message.sender_username),
      bot: message.message_type !== "system" && botUsernames.has(message.sender_username),
      me: message.sender_id === user?.id,
      time: clockOf(message.created_at),
      body: message.content,
      reactions: message.reactions ?? [],
    }));
  }, [page, botUsernames, user]);

  // 最新消息（或切房间）变化后滚到底部；加载更早消息不触发
  const latestId = page?.messages[0]?.id;
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [roomId, latestId]);

  // 向上翻页：before= 当前最早一条消息的 id，把更早的一页并入缓存
  const loadMore = async () => {
    const cursor = page?.next_before;
    if (!roomId || !cursor) return;
    const res = await api.GET("/api/v1/rooms/{room_id}/messages", {
      params: { path: { room_id: roomId }, query: { before: cursor, limit: MESSAGE_PAGE_SIZE } },
    });
    const older = res.data as MessagesPage | null;
    if (!older || older.messages.length === 0) {
      toast.info(t("chat.noEarlierMessages"));
      return;
    }
    queryClient.setQueryData<MessagesPage>(["messages", roomId, ""], (old) =>
      old
        ? { messages: [...old.messages, ...older.messages], has_more: older.has_more, next_before: older.next_before }
        : older,
    );
  };

  const unreadMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of unread ?? []) map.set(entry.room_id, entry.unread_count);
    return map;
  }, [unread]);

  // 仓库房间按 repository_id 归组；当前仓库所在的分组高亮
  const groups: ChatRoomGroup[] = useMemo(() => {
    const byRepo = new Map<string, ChatRoomGroup["rooms"]>();
    for (const item of roomList) {
      const key = item.repository_id ?? "";
      const list = byRepo.get(key) ?? [];
      list.push({
        id: item.id,
        name: item.name,
        unread: unreadMap.get(item.id) || undefined,
        active: item.id === roomId,
      });
      byRepo.set(key, list);
    }
    return [...byRepo.entries()].map(([repoId, list]) => ({
      repo: repos.find((repo) => repo.id === repoId)?.path ?? t("chat.otherRepo"),
      active: repoId !== "" && repoId === currentRepo?.id,
      rooms: list,
    }));
  }, [roomList, unreadMap, repos, roomId, currentRepo, t]);

  // bot 置顶（后端 get_members 注释约定），其余按用户名排序
  const sortedMembers = useMemo(
    () =>
      [...(members ?? [])].sort(
        (a, b) => Number(b.is_bot) - Number(a.is_bot) || a.username.localeCompare(b.username),
      ),
    [members],
  );

  return (
    <div className="mx-auto w-full max-w-[1560px] px-[34px] pt-[18px] pb-8">
      <Stage
        dock={[
          { id: "people", icon: Users, label: t("chat.members"), kicker: room?.name ?? "" },
          { id: "doc", icon: FileText, label: t("chat.sharedDocs"), kicker: room?.name ?? "" },
        ]}
        panel={(tab) =>
          tab.id === "people" ? (
            <MembersPanel
              members={sortedMembers}
              loading={membersLoading}
              online={channel.online}
              currentUserId={user?.id ?? null}
            />
          ) : (
            <DocsPanel />
          )
        }
      >
      <div className="border-edge-2 bg-ink-900/60 grid h-[calc(100vh-150px)] min-h-[600px] grid-cols-[218px_minmax(0,1fr)] overflow-hidden rounded-[14px] border">
        <ChannelsColumn
          groups={groups}
          dms={dms ?? []}
          dmsLoading={loadingDms}
          unreadMap={unreadMap}
          status={channel.status}
          activeRoomId={roomId}
          onSelect={(id) => setSearchParams({ room: id })}
        />
        <section className="bg-ink-950 flex min-w-0 flex-col overflow-hidden bg-[radial-gradient(700px_300px_at_50%_-10%,rgba(242,174,91,0.035),transparent_70%)]">
          {room ? (
            <>
              <RoomHeader
                room={room}
                memberCount={sortedMembers.length}
                dm={isDm}
                onlineCount={channel.online.length}
                searchActive={searchOpen}
                onToggleSearch={toggleSearch}
                onRoomDeleted={() => setSearchParams({})}
              />
              {searchOpen ? (
                <div className="border-edge-2 bg-ink-950/60 mx-[18px] mt-2 flex flex-none items-center gap-2 rounded-md border px-2.5 py-1.5">
                  <Search className="text-faint size-[13px] shrink-0" aria-hidden="true" />
                  <input
                    autoFocus
                    type="text"
                    value={keyword}
                    onChange={(event) => setKeyword(event.target.value)}
                    placeholder={t("chat.searchInRoom")}
                    aria-label={t("chat.searchRoomAria")}
                    className="text-bone placeholder:text-muted-2 min-w-0 flex-1 bg-transparent text-xs focus-visible:outline-none"
                  />
                  {search ? (
                    <span className="text-faint shrink-0 font-mono text-2xs">
                      {loadingMessages ? t("chat.searching") : `${messages.length}`}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={toggleSearch}
                    aria-label={t("chat.closeSearch")}
                    className="text-muted-2 hover:text-bone shrink-0 transition-colors"
                  >
                    <X className="size-[13px]" aria-hidden="true" />
                  </button>
                </div>
              ) : null}
              <TopicBanner topic={room.topic} />
              <div ref={listRef} aria-live="polite" className="min-h-0 flex-1 overflow-y-auto px-[18px] pt-2.5 pb-1">
                {page?.has_more && !search ? (
                  <div className="my-2 flex justify-center">
                    <button
                      type="button"
                      onClick={() => void loadMore()}
                      className="border-edge-2 text-muted hover:border-edge-3 hover:text-bone rounded-md border px-2.5 py-1 text-xs transition-colors"
                    >
                      {t("chat.loadEarlier")}
                    </button>
                  </div>
                ) : null}
                <div className="text-faint my-2 flex items-center gap-2.5 font-mono text-2xs uppercase">
                  <span className="bg-edge-1 h-px flex-1" />
                  {t("chat.today", {
                    date: new Date().toLocaleDateString(currentLocale() === "en" ? "en-US" : "zh-CN", {
                      month: "long",
                      day: "numeric",
                    }),
                  })}
                  <span className="bg-edge-1 h-px flex-1" />
                </div>
                {loadingMessages && messages.length === 0 ? (
                  <MessageBubblesSkeleton rows={4} className="pt-1" />
                ) : null}
                {!loadingMessages && messages.length === 0 ? (
                  <p className="text-muted-2 py-6 text-center text-xs">
                    {search ? t("chat.noSearchResults", { q: search }) : t("chat.noMessagesYet")}
                  </p>
                ) : null}
                {messages.map((message) => (
                  <MessageRow
                    key={message.id}
                    message={message}
                    canReact={channel.status === "open"}
                    onReact={(emoji) =>
                      channel.sendReaction(
                        message.id,
                        emoji,
                        !message.reactions?.some((item) => item.emoji === emoji && item.active),
                      )
                    }
                  />
                ))}
              </div>
              {channel.typing.length > 0 ? (
                <p className="text-muted-2 flex flex-none items-center gap-1.5 px-[18px] pb-1 text-xs">
                  <Lamp tone="warn" live />
                  {channel.typing.slice(0, 3).join("、")} {t("chat.typing")}…
                </p>
              ) : null}
              <Composer
                sendLabel={t("chat.send")}
                placeholder={t("chat.placeholder")}
                connected={channel.status === "open"}
                onSend={(text) => {
                  if (channel.sendMessage(text)) return true;
                  toast.error(t("chat.notConnectedToast"));
                  return false;
                }}
                onTyping={channel.notifyTyping}
                onAttach={async (file) => {
                  if (!roomId) return null;
                  const token = getAccessToken();
                  const form = new FormData();
                  form.append("file", file);
                  // multipart 走原生 fetch：openapi 客户端只处理 JSON 请求体
                  const res = await fetch(`/api/v1/rooms/${roomId}/attachments`, {
                    method: "POST",
                    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
                    body: form,
                  });
                  if (!res.ok) {
                    toast.error(t("chat.attachFailed"));
                    return null;
                  }
                  const data = (await res.json()) as { name?: string; url?: string; content_type?: string };
                  if (!data.url) return null;
                  const label = data.name ?? file.name;
                  toast.success(t("chat.attachUploaded"));
                  return data.content_type?.startsWith("image/")
                    ? `![${label}](${data.url})`
                    : `[${label}](${data.url})`;
                }}
              />
            </>
          ) : loadingRooms ? (
            <ConversationSkeleton />
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <p className="text-muted-2 text-sm">{t("chat.noAccessibleChannels")}</p>
            </div>
          )}
        </section>
      </div>
      </Stage>
    </div>
  );
}

/**
 * 消息气泡骨架：头像 + 两行正文，左右交替。
 *
 * 房间首屏取数时用。左右错落是为了让「一半是我说的」这层结构先立起来，
 * 数据到达后气泡落到各自的一侧，观感上只是显影而不是重排。
 */
function MessageBubblesSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={cn("flex flex-col gap-4", className)}>
      {Array.from({ length: rows }).map((_, row) => (
        <div key={row} className={cn("flex items-start gap-2.5", row % 2 === 1 && "flex-row-reverse")}>
          <Skeleton className="size-7 flex-none rounded-full" />
          <div
            className="flex min-w-0 flex-col gap-1.5"
            style={{ width: `${40 + ((row * 13) % 34)}%` }}
          >
            <Skeleton className="h-2 w-16" />
            <Skeleton className="h-2.5" />
            <Skeleton className="h-2.5" style={{ width: "76%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 会话骨架：房间头 + 气泡 + 输入条。
 *
 * 房间列表还在加载、尚未选中任何房间时占位。画成「已有对话在进行」的样子，
 * 数据到达后版式不发生位移，也不会先闪一句空态文案。
 */
function ConversationSkeleton() {
  return (
    <div aria-hidden="true" className="flex min-h-0 flex-1 flex-col">
      <div className="border-edge-2 flex items-center gap-2.5 border-b px-[18px] py-3">
        <Skeleton className="size-7 flex-none rounded-md" />
        <Skeleton className="h-3 w-28" />
        <Skeleton className="ml-auto h-2 w-16" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-[18px] py-4">
        <MessageBubblesSkeleton />
      </div>
      <div className="border-edge-1 border-t p-[18px]">
        <Skeleton className="h-9 rounded-md" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 左栏：频道侧栏                                                      */
/* ------------------------------------------------------------------ */

/** 频道侧栏：仓库分组的房间、私聊与连接状态，顶部带房间过滤框。 */
function ChannelsColumn({
  groups,
  dms,
  dmsLoading,
  unreadMap,
  status,
  activeRoomId,
  onSelect,
}: {
  groups: ChatRoomGroup[];
  dms: DmRoomDto[];
  /** 私聊单独取数，未就绪时不能渲染成「暂无私聊」。 */
  dmsLoading: boolean;
  unreadMap: Map<string, number>;
  status: RoomChannelStatus;
  activeRoomId: string | null;
  onSelect: (roomId: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const visible = groups
    .map((group) => ({
      ...group,
      rooms: group.rooms.filter((room) => room.name.toLowerCase().includes(q)),
    }))
    .filter((group) => group.rooms.length > 0);
  const visibleDms = dms.filter((dm) => dm.peer_username.toLowerCase().includes(q));

  return (
    <aside aria-label={t("chat.channels")} className="bg-ink-950/60 border-edge-2 flex min-w-0 flex-col overflow-hidden border-r">
      <div className="flex-none px-[13px] pt-4 pb-[11px]">
        <p className="text-faint text-2xs font-semibold tracking-[0.15em] uppercase">Kustos</p>
        <h1 className="font-display text-bone mt-[5px] text-[1.6rem] leading-none font-medium">{t("chat.title")}</h1>
      </div>
      <div className="flex-none px-[11px] pb-[11px]">
        <div className="border-edge-2 bg-ink-900/70 focus-within:border-amber/40 flex h-[30px] items-center gap-1.5 rounded-md border px-2 transition-colors">
          <Search className="text-faint size-3" aria-hidden="true" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("chat.findRoom")}
            aria-label={t("chat.findRoomAria")}
            className="text-bone placeholder:text-muted-2 min-w-0 flex-1 bg-transparent text-xs focus-visible:outline-none"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        <section className="px-[7px] pb-2.5">
          <p className="text-faint px-2 pt-[9px] pb-[5px] text-2xs font-semibold tracking-[0.15em] uppercase">{t("chat.groupByRepo")}</p>
          {visible.length === 0 ? (
            <p className="text-muted-2 px-2 py-1 text-xs">{t("chat.noChannels")}</p>
          ) : null}
          {visible.map((group) => (
            <div key={group.repo} className="mt-0.5">
              <p
                className={cn(
                  "flex items-center gap-1.5 px-2 pt-1.5 pb-1 font-mono text-2xs",
                  group.active ? "text-amber-3" : "text-muted-2",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-[5px] flex-none rounded-sm",
                    group.active ? "bg-amber shadow-[0_0_8px_rgba(242,174,91,0.6)]" : "bg-faint",
                  )}
                />
                {group.repo}
              </p>
              <div className="border-edge-1 ml-[10px] border-l pl-2">
                {group.rooms.map((room) => (
                  <ChannelItem
                    key={room.id}
                    prefix="#"
                    name={room.name}
                    unread={room.unread}
                    active={room.active}
                    onClick={() => onSelect(room.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </section>

        <section className="px-[7px] pb-2.5">
          <p className="text-faint flex items-center gap-1 px-2 pt-[9px] pb-[5px] text-2xs font-semibold tracking-[0.15em] uppercase">
            {t("chat.dmLabel")}
            <span className="ml-auto normal-case">
              <StartDmButton onCreated={onSelect} />
            </span>
          </p>
          {visibleDms.length === 0 ? (
            dmsLoading ? (
              <div className="flex flex-col gap-1 px-2 py-1">
                {[0, 1].map((row) => (
                  <div key={row} className="flex items-center gap-2 py-1">
                    <Skeleton className="size-[18px] flex-none rounded-md" />
                    <Skeleton className="h-2.5" style={{ width: `${44 + row * 16}%` }} />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-2 px-2 py-1 text-xs">
                {dms.length === 0 ? t("chat.noDms") : t("chat.noDmMatch")}
              </p>
            )
          ) : (
            visibleDms.map((dm) => (
              <ChannelItem
                key={dm.room_id}
                prefix="@"
                name={dm.peer_username}
                unread={unreadMap.get(dm.room_id) || dm.unread_count || undefined}
                active={dm.room_id === activeRoomId}
                onClick={() => onSelect(dm.room_id)}
              />
            ))
          )}
        </section>
      </div>

      <div className="border-edge-2 text-muted-2 flex flex-none items-center gap-1.5 border-t px-3 py-[9px] font-mono text-2xs">
        <Lamp
          tone={status === "open" ? "good" : status === "connecting" ? "warn" : "bad"}
          live={status === "connecting"}
        />
        {t(CHANNEL_STATUS_KEY[status])}
      </div>
    </aside>
  );
}

/** 频道条目：# 前缀 + 名称 + 未读徽标，激活态琥珀 wash。 */
function ChannelItem({
  prefix,
  name,
  unread,
  active,
  onClick,
}: {
  prefix: string;
  name: string;
  unread?: number;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-[29px] w-full items-center gap-[7px] rounded px-2 text-left text-xs transition-colors",
        active ? "bg-[linear-gradient(90deg,rgba(242,174,91,0.1),rgba(242,174,91,0.02))] text-bone" : "text-muted hover:bg-ink-750/50 hover:text-bone-2",
      )}
    >
      <span className={cn("font-mono text-sm", active ? "text-amber" : "text-faint")}>{prefix}</span>
      <span className="min-w-0 truncate">{name}</span>
      {unread ? (
        <span
          className={cn(
            "ml-auto inline-grid min-w-4 place-items-center rounded-full px-1 font-mono text-2xs leading-4",
            active ? "bg-amber/10 text-amber" : "bg-bone/[0.07] text-muted-2",
          )}
        >
          {unread}
        </span>
      ) : null}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* 中栏：房间头、消息与输入框                                          */
/* ------------------------------------------------------------------ */

/** 房间头：房间名 + 主题/成员摘要 + 房间操作。 */
function RoomHeader({
  room,
  memberCount,
  dm,
  onlineCount,
  searchActive,
  onToggleSearch,
  onRoomDeleted,
}: {
  room: RoomDto;
  memberCount: number;
  dm: boolean;
  onlineCount: number;
  searchActive: boolean;
  onToggleSearch: () => void;
  onRoomDeleted: () => void;
}) {
  const { t } = useTranslation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 在线人数来自实时通道；未连上时只报成员总数，不谎报在线
  const summary = dm
    ? `${t("chat.dmLabel")} · ${
        onlineCount > 0 ? t("chat.onlineCount", { count: onlineCount }) : t("chat.offline")
      }`
    : `${room.topic ?? t("chat.noTopic")} · ${t("chat.memberCount", { count: memberCount })}${
        onlineCount > 0 ? ` · ${t("chat.onlineShort", { count: onlineCount })}` : ""
      }`;
  return (
    <header className="bg-ink-950/50 border-edge-2 flex flex-none items-center justify-between gap-3.5 border-b px-[18px] py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span aria-hidden="true" className="font-display text-amber text-[1.2rem]">
            {dm ? "@" : "#"}
          </span>
          <h2 className="font-display text-bone text-[1.3rem] leading-none font-medium">{room.name}</h2>
          <span className="border-edge-2 text-muted inline-flex h-[17px] items-center rounded-full border px-[7px] text-2xs">
            {dm ? "dm" : "room"}
          </span>
        </div>
        <p className="text-muted-2 mt-1 truncate text-xs">{summary}</p>
      </div>
      <div className="flex flex-none items-center gap-0.5">
        <button
          type="button"
          aria-label={t("chat.searchRoomAria")}
          aria-pressed={searchActive}
          onClick={onToggleSearch}
          className={cn(
            "grid size-[26px] place-items-center rounded-md transition-colors",
            searchActive ? "bg-amber/15 text-amber" : "text-muted-2 hover:bg-bone/5 hover:text-bone",
          )}
        >
          <Search className="size-[14px]" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={t("chat.roomSettings")}
          onClick={() => setSettingsOpen(true)}
          className="text-muted-2 hover:bg-bone/5 hover:text-bone grid size-[26px] place-items-center rounded-md transition-colors"
        >
          <Settings className="size-[14px]" aria-hidden="true" />
        </button>
      </div>

      <RoomSettingsDialog
        roomId={room.id}
        roomName={room.name}
        isDm={dm}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onDeleted={onRoomDeleted}
      />
    </header>
  );
}

/** 置顶话题横幅：房间有 topic 才渲染。 */
function TopicBanner({ topic }: { topic: string | null }) {
  const { t } = useTranslation();
  if (!topic) return null;
  return (
    <div className="border-amber/20 bg-amber/5 text-muted mx-[18px] mt-2.5 flex flex-none items-center gap-[7px] rounded-md border px-2.5 py-[7px] text-xs">
      <Pin className="text-amber size-[13px] flex-none" aria-hidden="true" />
      <span className="min-w-0 truncate">
        <strong className="text-amber-2 font-semibold">{t("chat.topicLabel")}</strong> {topic}
      </span>
    </div>
  );
}

/** 消息正文：Markdown 渲染，@kustos-agent 提及以琥珀胶囊高亮。 */
function ChatBody({ content, className }: { content: string; className?: string }) {
  /* 提及的着色交给 rehype 插件（lib/markdown/rehype-mention.ts）。
     早先这里按提及字面量切分源文、逐段渲染 Markdown，只要提及落在
     代码块、加粗或列表项内部，语法就会被切断。 */
  return (
    <Markdown
      content={content}
      mentions
      className={cn("text-muted text-sm leading-[1.62]", className)}
    />
  );
}

/** 单条消息：头像 + 作者行 + 正文；bot / 自己的消息有专属消息体样式。 */
function MessageRow({
  message,
  onReact,
  canReact,
}: {
  message: ChatMessage;
  /** 回应当前表情；同一 emoji 再点一次即取消。 */
  onReact?: (emoji: string) => void;
  canReact?: boolean;
}) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const reactions = message.reactions ?? [];

  return (
    <article className="grid grid-cols-[29px_minmax(0,1fr)] gap-2.5 py-[9px]">
      <ToneAvatar initials={message.initials} tone={message.tone} bot={message.bot} size="sm" className="mt-0.5" />
      <div className="min-w-0 pt-px">
        <div className="flex flex-wrap items-center gap-[7px]">
          <strong className="text-bone-2 text-xs font-semibold">{message.author}</strong>
          {message.me ? (
            <span className="border-edge-2 text-muted-2 inline-flex h-[15px] items-center rounded-full border px-1.5 text-2xs">{t("chat.you")}</span>
          ) : null}
          {message.bot ? (
            <span className="border-amber/30 bg-amber/10 text-amber-2 inline-flex h-[15px] items-center rounded-full border px-1.5 text-2xs">bot</span>
          ) : null}
          <time className="text-faint font-mono text-2xs">{message.time}</time>
        </div>
        <ChatBody
          content={message.body}
          className={cn(
            "mt-1 max-w-[min(68ch,600px)]",
            message.bot &&
              "border-y border-r border-l-2 border-amber/20 border-l-amber bg-[linear-gradient(90deg,rgba(242,174,91,0.07),rgba(17,28,34,0.55))] mt-1.5 rounded-r-md px-[11px] py-2 text-bone-2",
            message.me && "border-edge-1 bg-ink-750/35 mt-1 rounded-md border px-[10px] py-2 text-bone-2",
          )}
        />

        {/* 表情回应：已有聚合在前，选择器按需展开 */}
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {reactions.map((reaction) => (
            <button
              key={reaction.emoji}
              type="button"
              onClick={() => onReact?.(reaction.emoji)}
              aria-pressed={reaction.active}
              aria-label={t("chat.reactionAria", { emoji: reaction.emoji, count: reaction.count })}
              className={cn(
                "inline-flex h-[19px] items-center gap-1 rounded-full border px-1.5 font-mono text-2xs transition-colors",
                reaction.active
                  ? "border-amber/40 bg-amber/10 text-amber-2"
                  : "border-edge-2 text-muted-2 hover:border-edge-3 hover:text-bone-2",
              )}
            >
              <span aria-hidden="true">{reaction.emoji}</span>
              <span>{reaction.count}</span>
            </button>
          ))}

          {pickerOpen
            ? QUICK_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => {
                    onReact?.(emoji);
                    setPickerOpen(false);
                  }}
                  aria-label={t("chat.reactAria", { emoji })}
                  className="border-edge-2 hover:border-amber/40 hover:bg-amber/10 inline-flex size-[19px] items-center justify-center rounded-full border text-2xs transition-colors"
                >
                  {emoji}
                </button>
              ))
            : null}

          <button
            type="button"
            onClick={() => setPickerOpen((open) => !open)}
            disabled={!canReact}
            aria-label={t("chat.addReactionAria")}
            aria-expanded={pickerOpen}
            className="border-edge-2 text-faint hover:border-edge-3 hover:text-bone-2 inline-flex h-[19px] items-center rounded-full border px-1.5 text-2xs transition-colors disabled:opacity-40"
          >
            <Smile className="size-[11px]" aria-hidden="true" />
          </button>
        </div>
      </div>
    </article>
  );
}

/** 快速回应的固定表情集；服务端只校验非空与长度。 */
const QUICK_EMOJIS = ["👍", "❤️", "🎉", "👀", "😄"];

/**
 * 消息输入框。
 *
 * Enter 发送、Shift+Enter 换行；输入时上报「正在输入」，停止输入由实时通道
 * 自动补发结束帧。通道未连上时整体禁用——消息只有 WebSocket 一条通路。
 */
function Composer({
  sendLabel,
  placeholder,
  connected,
  onSend,
  onTyping,
  onAttach,
}: {
  sendLabel: string;
  placeholder: string;
  connected: boolean;
  /** 返回 true 表示已交给通道，输入框据此清空。 */
  onSend: (text: string) => boolean;
  onTyping: () => void;
  /** 上传附件并返回要插入输入框的 Markdown 片段；失败返回 null。 */
  onAttach?: (file: File) => Promise<string | null>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    if (onSend(text)) setDraft("");
  };

  const pickFile = async (file: File) => {
    if (!onAttach || uploading) return;
    setUploading(true);
    try {
      const snippet = await onAttach(file);
      if (snippet) setDraft((prev) => (prev ? `${prev}\n${snippet}` : snippet));
    } finally {
      setUploading(false);
      // 允许重复选择同一个文件
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const tools = [
    { icon: AtSign, label: t("chat.mentionLabel"), toast: t("chat.mentionToast") },
    { icon: Smile, label: t("chat.emojiLabel"), toast: t("chat.emojiToast") },
  ];
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="border-edge-1 bg-ink-950/75 flex flex-none flex-col border-t px-4 pt-[9px] pb-3"
    >
      <div className="border-edge-2 bg-ink-1000/55 overflow-hidden rounded-[10px] border transition-colors focus-within:border-amber/40">
        <textarea
          rows={1}
          value={draft}
          disabled={!connected}
          aria-label={t("chat.inputAria")}
          placeholder={connected ? placeholder : t("chat.connectingPlaceholder")}
          onChange={(event) => {
            setDraft(event.target.value);
            onTyping();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          className="text-bone placeholder:text-muted-2 max-h-[140px] min-h-[42px] w-full resize-none bg-transparent px-[11px] pt-2.5 pb-0.5 text-sm leading-[1.58] focus-visible:outline-none disabled:opacity-60"
        />
        <div className="flex items-center gap-0.5 px-1.5 py-1">
          <input
            ref={fileRef}
            type="file"
            hidden
            aria-hidden="true"
            tabIndex={-1}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void pickFile(file);
            }}
          />
          <button
            type="button"
            aria-label={t("chat.addAttachment")}
            title={t("chat.addAttachment")}
            disabled={!connected || uploading || !onAttach}
            onClick={() => fileRef.current?.click()}
            className="text-muted-2 hover:bg-bone/5 hover:text-bone grid size-[25px] place-items-center rounded-md transition-colors disabled:opacity-40"
          >
            {uploading ? <span className="text-2xs">…</span> : <Paperclip className="size-[13px]" aria-hidden="true" />}
          </button>
          {tools.map((tool) => (
            <button
              key={tool.label}
              type="button"
              aria-label={tool.label}
              onClick={() => toast.info(tool.toast)}
              className="text-muted-2 hover:bg-bone/5 hover:text-bone grid size-[25px] place-items-center rounded-md transition-colors"
            >
              <tool.icon className="size-[13px]" aria-hidden="true" />
            </button>
          ))}
          <span className="text-faint ml-auto mr-1.5 font-mono text-2xs">
            {connected ? t("chat.sendHint") : t("chat.disconnected")}
          </span>
          <button
            type="submit"
            disabled={!connected || !draft.trim()}
            className="bg-amber border-amber hover:bg-amber-2 hover:border-amber-2 inline-flex h-[27px] items-center gap-[7px] whitespace-nowrap rounded-md border px-2.5 text-xs font-semibold text-ink-950 transition-colors disabled:pointer-events-none disabled:opacity-60"
          >
            <Send className="size-[13px]" aria-hidden="true" />
            {sendLabel}
          </button>
        </div>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* 右栏：共享文档与在线成员                                            */
/* ------------------------------------------------------------------ */

/** 房间成员面板（右缘浮窗）。 */
function MembersPanel({
  members,
  loading,
  online,
  currentUserId,
}: {
  members: RoomMemberDto[];
  /** 成员仍在取数：面板显示占位，而不是「暂无成员」。 */
  loading: boolean;
  online: PresenceUser[];
  currentUserId: string | null;
}) {
  const { t } = useTranslation();
  const onlineIds = new Set(online.map((item) => item.user_id));
  return (
    <RailBlock title={`${t("chat.members")} · ${members.length}`}>
      {members.length === 0 ? (
        loading ? (
          <div aria-hidden="true" className="flex flex-col gap-2">
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex items-center gap-[9px] py-1">
                <Skeleton className="size-[23px] flex-none rounded-full" />
                <Skeleton className="h-2.5" style={{ width: `${46 + row * 12}%` }} />
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted-2 text-xs">{t("chat.noMembers")}</p>
        )
      ) : (
        <ul>
          {members.map((member) => {
            const isOnline = onlineIds.has(member.user_id);
            return (
              <li key={member.id} className="flex items-center gap-[9px] py-1.5">
                <ToneAvatar
                  initials={initialsOf(member.username)}
                  tone={toneFor(member.username)}
                  bot={member.is_bot}
                  size="sm"
                />
                <span className="min-w-0 flex-1">
                  <strong className="text-bone-2 block text-xs font-medium leading-[1.35]">{member.username}</strong>
                  <span className="text-muted-2 block text-2xs leading-[1.4]">
                    {member.user_id === currentUserId
                      ? t("chat.you")
                      : member.role === "admin"
                        ? t("chat.adminRole")
                        : t("chat.member")}
                  </span>
                </span>
                <Lamp tone={isOnline ? "good" : "neutral"} live={isOnline} />
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-faint mt-2 text-2xs">
        {online.length > 0 ? t("chat.onlineCount", { count: online.length }) : t("chat.nobodyOnline")}
      </p>
    </RailBlock>
  );
}

/** 共享文档入口（协作编辑器在代码页）。 */
function DocsPanel() {
  const { t } = useTranslation();
  return (
    <RailBlock title={t("chat.sharedDocs")}>
      <div className="border-edge-2 bg-ink-1000/55 rounded-md border px-3 py-5 text-center">
        <p className="text-muted-2 text-xs">{t("chat.docsHint")}</p>
        <p className="text-faint mt-1 text-2xs leading-[1.4]">{t("chat.docsSubHint")}</p>
      </div>
    </RailBlock>
  );
}
