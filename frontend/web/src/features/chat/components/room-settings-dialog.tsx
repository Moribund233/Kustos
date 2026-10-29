import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Lamp } from "@/components/kit/kit";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import type { RoomMemberDto } from "@/features/chat/types";
import { api, getAccessToken } from "@/lib/api/client";
import { useApiMutation, useApiQuery } from "@/lib/api/hooks";
import { useAuthStore } from "@/stores/auth-store";

interface UserRow {
  id: string;
  username: string;
}

/**
 * 房间成员接口在生成的 schema 里没有建模（rooms 组只生成了读接口），
 * 这里用原生 fetch 发写请求，避免用 any 绕过类型。
 */
async function roomRequest(
  method: string,
  path: string,
  body: unknown,
  t: (key: string, options?: Record<string, unknown>) => string,
): Promise<unknown> {
  const token = getAccessToken();
  const res = await fetch(path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(payload.detail ?? t("chat.requestFailed", { status: res.status }));
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

const SELECT_CLASS =
  "border-edge-2 bg-ink-950/60 text-bone focus:border-amber/40 h-8 rounded-md border px-2 text-[11px] outline-none transition-colors";

/**
 * 房间设置：成员与角色、本人静音、删除会话。
 *
 * 管理权限（房间 admin / 仓库管理员 / 全局管理员）由后端 `_require_room_admin`
 * 裁决，前端只负责把 403 显示出来。私聊不提供拉人/角色入口。
 */
export function RoomSettingsDialog({
  roomId,
  roomName,
  isDm,
  open,
  onOpenChange,
  onDeleted,
}: {
  roomId: string;
  roomName: string;
  isDm: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const me = useAuthStore((state) => state.user);
  const [addUserId, setAddUserId] = useState("");
  const { t } = useTranslation();
  const [addRole, setAddRole] = useState("member");

  const membersQuery = useApiQuery<RoomMemberDto[]>({
    queryKey: ["room-members", roomId],
    enabled: open && !!roomId,
    queryFn: async () => {
      const res = await api.GET("/api/v1/rooms/{room_id}/members", {
        params: { path: { room_id: roomId } },
      });
      if (res.error) throw new Error(t("chat.memberLoadFailed"));
      return (Array.isArray(res.data) ? res.data : []) as RoomMemberDto[];
    },
  });

  const usersQuery = useApiQuery<UserRow[]>({
    queryKey: ["users"],
    enabled: open && !isDm,
    queryFn: async () => {
      const res = await api.GET("/api/v1/users");
      if (res.error) throw new Error(t("chat.memberLoadFailed"));
      return (Array.isArray(res.data) ? res.data : []) as UserRow[];
    },
  });

  useEffect(() => {
    if (!open) {
      setAddUserId("");
      setAddRole("member");
    }
  }, [open]);

  const refreshMembers = () =>
    queryClient.invalidateQueries({ queryKey: ["room-members", roomId] });

  const memberAction = useApiMutation<
    void,
    { userId: string; action: "role" | "remove"; role?: string }
  >(
    async ({ userId, action, role }) => {
      if (action === "remove") {
        await roomRequest("DELETE", `/api/v1/rooms/${roomId}/members/${userId}`, undefined, t);
        return;
      }
      await roomRequest("PATCH", `/api/v1/rooms/${roomId}/members/${userId}`, { role }, t);
    },
    {
      onSuccess: async () => {
        await refreshMembers();
        toast.success(t("chat.memberUpdated"));
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const addMutation = useApiMutation<void, { userId: string; role: string }>(
    async ({ userId, role }) => {
      await roomRequest("POST", `/api/v1/rooms/${roomId}/members`, { user_id: userId, role }, t);
    },
    {
      onSuccess: async () => {
        await refreshMembers();
        setAddUserId("");
        toast.success(t("chat.memberAdded"));
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const muteMutation = useApiMutation<void, boolean>(
    async (muted) => {
      await roomRequest("POST", `/api/v1/rooms/${roomId}/members/me`, { muted }, t);
    },
    {
      onSuccess: async () => {
        await refreshMembers();
        void queryClient.invalidateQueries({ queryKey: ["rooms"] });
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const deleteMutation = useApiMutation<void, void>(
    async () => {
      await roomRequest("DELETE", `/api/v1/rooms/${roomId}`, undefined, t);
    },
    {
      onSuccess: () => {
        toast.success(t("chat.roomDeleted"));
        onOpenChange(false);
        void queryClient.invalidateQueries({ queryKey: ["rooms"] });
        void queryClient.invalidateQueries({ queryKey: ["dm"] });
        onDeleted();
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const members = membersQuery.data ?? [];
  const myMembership = useMemo(
    () => (membersQuery.data ?? []).find((member) => member.user_id === me?.id) ?? null,
    [membersQuery.data, me?.id],
  );

  const candidates = (usersQuery.data ?? []).filter(
    (item) => !members.some((member) => member.user_id === item.id),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{t("chat.roomSettings")}</DialogTitle>
          <DialogDescription>
            {isDm ? `${t("chat.dmLabel")} · ` : "#"}
            {roomName}
          </DialogDescription>
        </DialogHeader>

        {myMembership ? (
          <label className="border-edge-1 flex items-center justify-between gap-3 rounded-md border px-3 py-2">
<span className="text-muted text-[11.5px]">{t("chat.muteSelf")}</span>
            <Switch
              checked={myMembership.is_muted}
              disabled={muteMutation.isPending}
              onCheckedChange={(checked) => muteMutation.mutate(checked)}
              aria-label={t("chat.muteSelf")}
            />
          </label>
        ) : null}

        <div className="border-edge-1 max-h-[300px] min-h-[120px] overflow-auto rounded-md border">
          {membersQuery.isLoading ? (
            <p className="text-muted-2 p-3 text-[11.5px]">{t("common.loading")}</p>
          ) : members.length === 0 ? (
            <p className="text-muted-2 p-3 text-[11.5px]">{t("chat.noMembers")}</p>
          ) : (
            <ul>
              {members.map((member) => {
                const isSelf = member.user_id === me?.id;
                return (
                  <li
                    key={member.id}
                    className="border-edge-1 flex items-center gap-2 border-b px-3 py-2 last:border-b-0"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="text-bone-2 block truncate text-[11.5px] font-medium">
                        {member.username}
                        {isSelf ? <span className="text-faint font-normal">{t("chat.you")}</span> : null}
                      </span>
                      {member.is_bot ? <span className="text-faint text-[10px]">bot</span> : null}
                    </span>
                    {isSelf ? (
                      <span className="text-muted-2 text-[10.5px]">{member.role}</span>
                    ) : (
                      <>
                        <select
                          value={member.role}
                          aria-label={`${member.username} 的角色`}
                          onChange={(event) =>
                            memberAction.mutate({
                              userId: member.user_id,
                              action: "role",
                              role: event.target.value,
                            })
                          }
                          className={SELECT_CLASS}
                        >
                          <option value="member">{t("chat.member")}</option>
                          <option value="admin">{t("chat.adminRole")}</option>
                        </select>
                        <button
                          type="button"
                          aria-label={t("common.delete")}
                          className="text-muted-2 hover:text-rose transition-colors"
                          onClick={() =>
                            memberAction.mutate({ userId: member.user_id, action: "remove" })
                          }
                        >
                          <Trash2 className="size-[13px]" aria-hidden="true" />
                        </button>
                      </>
                    )}
                    <Lamp tone={member.is_muted ? "neutral" : "good"} />
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {!isDm ? (
          <div className="flex items-center gap-2">
            <select
              value={addUserId}
              onChange={(event) => setAddUserId(event.target.value)}
              className={`${SELECT_CLASS} min-w-0 flex-1`}
              aria-label={t("chat.addMember")}
            >
              <option value="">{t("chat.addMember")}</option>
              {candidates.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.username}
                </option>
              ))}
            </select>
            <select
              value={addRole}
              onChange={(event) => setAddRole(event.target.value)}
              className={SELECT_CLASS}
              aria-label={t("chat.memberRole")}
            >
              <option value="member">{t("chat.member")}</option>
              <option value="admin">{t("chat.adminRole")}</option>
            </select>
            <Button
              size="sm"
              onClick={() => addMutation.mutate({ userId: addUserId, role: addRole })}
              disabled={!addUserId || addMutation.isPending}
            >
              {t("chat.join")}
            </Button>
          </div>
        ) : null}

        <div className="border-edge-1 flex items-center justify-between border-t pt-3">
          <span className="text-faint text-[10px]">{t("chat.deleteRoomHint")}</span>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="ghost" className="text-rose hover:text-rose-2">
                {t("chat.deleteRoom")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("chat.deleteRoomTitle")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("chat.deleteRoomDescription")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={() => deleteMutation.mutate()}>
                  {t("settings.confirmDelete")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </DialogContent>
    </Dialog>
  );
}
