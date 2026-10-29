import type { MessagesPage, RoomMessageDto } from "@/features/chat/types";

/**
 * 消息缓存合并。
 *
 * 缓存里的 messages 是倒序（最新在前）。同 id 视为编辑，原位替换；新 id
 * 插入后按 created_at 重排——广播帧与自己的 ack 可能乱序到达，单纯前插会
 * 出现「自己的消息排在别人后面」。
 */

/**
 * 把一条实时消息并入缓存页。
 *
 * @param page 现有缓存页；未加载时为 undefined
 * @param incoming 实时帧里的消息体
 * @returns 合并后的缓存页
 */
export function mergeMessage(page: MessagesPage | undefined, incoming: RoomMessageDto): MessagesPage {
  if (!page) return { messages: [incoming], has_more: false, next_before: null };
  const index = page.messages.findIndex((item) => item.id === incoming.id);
  const messages =
    index >= 0
      ? page.messages.map((item, position) => (position === index ? incoming : item))
      : [incoming, ...page.messages];
  messages.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return { ...page, messages };
}
