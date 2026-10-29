import { describe, expect, it } from "vitest";

import { mergeMessage } from "@/features/chat/lib/messages";
import type { MessagesPage, RoomMessageDto } from "@/features/chat/types";

/** 构造一条消息；只填与合并逻辑相关的字段。 */
function message(id: string, createdAt: string, content = id): RoomMessageDto {
  return {
    id,
    room_id: "room-1",
    sender_id: "user-1",
    sender_username: "lin",
    message_type: "text",
    content,
    reply_to: null,
    edited_at: null,
    created_at: createdAt,
  };
}

/** 倒序缓存页：最新在前，与后端分页返回顺序一致。 */
function page(messages: RoomMessageDto[]): MessagesPage {
  return { messages, has_more: true, next_before: "cursor-1" };
}

describe("mergeMessage", () => {
  it("缓存未加载时以单条消息建页", () => {
    const merged = mergeMessage(undefined, message("a", "2026-10-29T10:00:00Z"));
    expect(merged.messages).toHaveLength(1);
    expect(merged.has_more).toBe(false);
    expect(merged.next_before).toBeNull();
  });

  it("同 id 视为编辑，原位替换而不新增", () => {
    const old = page([message("b", "2026-10-29T10:02:00Z"), message("a", "2026-10-29T10:00:00Z")]);
    const merged = mergeMessage(old, message("a", "2026-10-29T10:00:00Z", "改过的内容"));
    expect(merged.messages).toHaveLength(2);
    expect(merged.messages.find((item) => item.id === "a")?.content).toBe("改过的内容");
  });

  it("乱序到达时按 created_at 重排，仍保持倒序", () => {
    const old = page([message("c", "2026-10-29T10:03:00Z"), message("a", "2026-10-29T10:01:00Z")]);
    // b 比 c 早、比 a 晚，直接前插会排到 c 前面
    const merged = mergeMessage(old, message("b", "2026-10-29T10:02:00Z"));
    expect(merged.messages.map((item) => item.id)).toEqual(["c", "b", "a"]);
  });

  it("保留分页游标，不因实时插入而丢失翻页能力", () => {
    const old = page([message("a", "2026-10-29T10:00:00Z")]);
    const merged = mergeMessage(old, message("b", "2026-10-29T10:05:00Z"));
    expect(merged.has_more).toBe(true);
    expect(merged.next_before).toBe("cursor-1");
    expect(merged.messages[0]?.id).toBe("b");
  });
});
