import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api/client";
import { useApiMutation, useApiQuery } from "@/lib/api/hooks";
import { useAuthStore } from "@/stores/auth-store";

/** GET /api/v1/users 的列表项。 */
interface UserRow {
  id: string;
  username: string;
  full_name?: string | null;
}

/**
 * 发起私聊。
 *
 * 私聊是 `room_type=dm` 的房间，`POST /dm` 幂等：已存在就返回原会话，
 * 因此重复点击不会造出第二个对话。
 */
export function StartDmDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (roomId: string) => void;
}) {
  const queryClient = useQueryClient();
  const me = useAuthStore((state) => state.user);
  const [query, setQuery] = useState("");

  const usersQuery = useApiQuery<UserRow[]>({
    queryKey: ["users"],
    enabled: open,
    queryFn: async () => {
      const res = await api.GET("/api/v1/users");
      if (res.error) throw new Error("用户列表加载失败。");
      return (Array.isArray(res.data) ? res.data : []) as UserRow[];
    },
  });

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const createMutation = useApiMutation<string, string>(
    async (peerUserId) => {
      const res = await api.POST("/api/v1/dm", { body: { peer_user_id: peerUserId } });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail;
        throw new Error(detail ?? "创建会话失败。");
      }
      const room = res.data as { id?: string } | undefined;
      if (!room?.id) throw new Error("创建成功但未返回房间。");
      return room.id;
    },
    {
      onSuccess: (roomId) => {
        void queryClient.invalidateQueries({ queryKey: ["dm"] });
        onOpenChange(false);
        onCreated(roomId);
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const candidates = (usersQuery.data ?? []).filter(
    (item) =>
      item.id !== me?.id &&
      (item.username.toLowerCase().includes(query.trim().toLowerCase()) ||
        (item.full_name ?? "").toLowerCase().includes(query.trim().toLowerCase())),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[440px]">
        <DialogHeader>
          <DialogTitle>发起私聊</DialogTitle>
          <DialogDescription>选择一位成员；已有会话会直接打开，不会重复创建。</DialogDescription>
        </DialogHeader>

        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索用户名…"
          aria-label="搜索用户"
          autoFocus
        />

        <div className="border-edge-1 max-h-[280px] min-h-[120px] overflow-auto rounded-md border">
          {usersQuery.isLoading ? (
            <p className="text-muted-2 p-3 text-[11.5px]">加载中…</p>
          ) : candidates.length === 0 ? (
            <p className="text-muted-2 p-3 text-[11.5px]">没有匹配的成员。</p>
          ) : (
            <ul>
              {candidates.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    disabled={createMutation.isPending}
                    onClick={() => createMutation.mutate(item.id)}
                    className="border-edge-1 hover:bg-ink-800/50 flex w-full items-center gap-2 border-b px-3 py-2 text-left transition-colors last:border-b-0 disabled:opacity-60"
                  >
                    <span className="text-bone-2 text-[12px] font-medium">{item.username}</span>
                    {item.full_name ? (
                      <span className="text-faint truncate text-[10.5px]">{item.full_name}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 侧栏「私聊」标题旁的 + 按钮，自带弹窗状态。 */
export function StartDmButton({ onCreated }: { onCreated: (roomId: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label="发起私聊"
        title="发起私聊"
        onClick={() => setOpen(true)}
        className="text-faint hover:text-amber-2 inline-flex size-4 items-center justify-center rounded transition-colors"
      >
        <Plus className="size-[12px]" aria-hidden="true" />
      </button>
      <StartDmDialog open={open} onOpenChange={setOpen} onCreated={onCreated} />
    </>
  );
}
