import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Lamp, ToneAvatar } from "@/components/kit/kit";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/client";
import { useApiMutation, useApiQuery } from "@/lib/api/hooks";

/** GET /repositories/{id}/members 的行（member_service 返回模型字段 + user 摘要）。 */
interface MemberRow {
  id: string;
  user_id: string;
  role: string;
  is_active: boolean;
  user?: { id: string; username: string; full_name?: string | null } | null;
}

interface UserRow {
  id: string;
  username: string;
}

const ROLES = ["admin", "developer", "readonly"] as const;
const ROLE_LABEL: Record<string, string> = {
  owner: "所有者",
  admin: "管理员",
  developer: "开发者",
  readonly: "只读",
};

const SELECT_CLASS =
  "border-edge-2 bg-ink-950/60 text-bone focus:border-amber/40 h-7 rounded-md border px-1.5 text-[10.5px] outline-none transition-colors";

/**
 * 仓库成员与角色。
 *
 * 全局管理员与仓库角色是两套授权：这里只改仓库角色（owner/admin/developer/
 * readonly），最终由后端 `ACTION_MATRIX` 裁决。owner 行不允许改角色或移除。
 */
export function MembersSection({ repoId }: { repoId: string }) {
  const queryClient = useQueryClient();
  const [addUserId, setAddUserId] = useState("");
  const [addRole, setAddRole] = useState<string>("developer");

  const membersQuery = useApiQuery<MemberRow[]>({
    queryKey: ["repo-members", repoId],
    enabled: !!repoId,
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/members", {
        params: { path: { repo_id: repoId } },
      });
      if (res.error) throw new Error("成员加载失败。");
      return (Array.isArray(res.data) ? res.data : []) as unknown as MemberRow[];
    },
  });

  const usersQuery = useApiQuery<UserRow[]>({
    queryKey: ["users"],
    queryFn: async () => {
      const res = await api.GET("/api/v1/users");
      return (Array.isArray(res.data) ? res.data : []) as UserRow[];
    },
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["repo-members", repoId] });

  const updateMutation = useApiMutation<void, { userId: string; body: Record<string, unknown> }>(
    async ({ userId, body }) => {
      const res = await api.PUT("/api/v1/repositories/{repo_id}/members/{user_id}", {
        params: { path: { repo_id: repoId, user_id: userId } },
        body: body as never,
      });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail;
        throw new Error(detail ?? "成员更新失败。");
      }
    },
    { onSuccess: refresh, onError: (error) => toast.error(error.message) },
  );

  const addMutation = useApiMutation<void, void>(
    async () => {
      const res = await api.POST("/api/v1/repositories/{repo_id}/members", {
        params: { path: { repo_id: repoId } },
        body: { user_id: addUserId, role: addRole } as never,
      });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail;
        throw new Error(detail ?? "添加成员失败。");
      }
    },
    {
      onSuccess: () => {
        toast.success("成员已加入。");
        setAddUserId("");
        void refresh();
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const removeMutation = useApiMutation<void, string>(
    async (userId) => {
      const res = await api.DELETE("/api/v1/repositories/{repo_id}/members/{user_id}", {
        params: { path: { repo_id: repoId, user_id: userId } },
      });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail;
        throw new Error(detail ?? "移除成员失败。");
      }
    },
    {
      onSuccess: () => {
        toast.success("成员已移除。");
        void refresh();
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const members = membersQuery.data ?? [];
  const candidates = (usersQuery.data ?? []).filter(
    (user) => !members.some((member) => member.user_id === user.id),
  );

  return (
    <section className="border-edge-2 bg-ink-900/50 rounded-[12px] border p-5">
      <h2 className="text-bone text-[13px] font-semibold">成员与角色</h2>
      <p className="text-muted-2 mt-1 text-[11px]">
        仓库角色独立于全局管理员；所有者由仓库归属决定，不能在这里移除。
      </p>

      <div className="mt-4 flex flex-col gap-2">
        {membersQuery.isLoading ? (
          <p className="text-muted-2 text-[11.5px]">加载中…</p>
        ) : members.length === 0 ? (
          <p className="text-muted-2 text-[11.5px]">还没有成员。</p>
        ) : (
          <ul className="border-edge-1 overflow-hidden rounded-md border">
            {members.map((member) => {
              const name = member.user?.username ?? member.user_id.slice(0, 8);
              const isOwner = member.role === "owner";
              return (
                <li
                  key={member.id}
                  className="border-edge-1 flex items-center gap-3 border-b px-3 py-2 last:border-b-0"
                >
                  <ToneAvatar initials={name.slice(0, 2).toUpperCase()} tone="slate" size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="text-bone-2 block truncate text-[12px] font-medium">{name}</span>
                    <span className="text-faint text-[10px]">
                      {ROLE_LABEL[member.role] ?? member.role}
                      {member.is_active ? "" : " · 已停用"}
                    </span>
                  </span>
                  <Lamp tone={member.is_active ? "good" : "neutral"} />
                  {isOwner ? null : (
                    <>
                      <select
                        value={member.role}
                        aria-label={`${name} 的角色`}
                        onChange={(event) =>
                          updateMutation.mutate({ userId: member.user_id, body: { role: event.target.value } })
                        }
                        className={SELECT_CLASS}
                      >
                        {ROLES.map((role) => (
                          <option key={role} value={role}>
                            {ROLE_LABEL[role]}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="text-muted-2 hover:text-amber-2 text-[10.5px] transition-colors"
                        onClick={() =>
                          updateMutation.mutate({
                            userId: member.user_id,
                            body: { is_active: !member.is_active },
                          })
                        }
                      >
                        {member.is_active ? "停用" : "启用"}
                      </button>
                      <button
                        type="button"
                        aria-label={`移除 ${name}`}
                        className="text-muted-2 hover:text-rose transition-colors"
                        onClick={() => removeMutation.mutate(member.user_id)}
                      >
                        <Trash2 className="size-[13px]" aria-hidden="true" />
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="flex items-center gap-2">
          <select
            value={addUserId}
            onChange={(event) => setAddUserId(event.target.value)}
            aria-label="选择用户"
            className={`${SELECT_CLASS} h-8 min-w-0 flex-1`}
          >
            <option value="">添加成员…</option>
            {candidates.map((user) => (
              <option key={user.id} value={user.id}>
                {user.username}
              </option>
            ))}
          </select>
          <select
            value={addRole}
            onChange={(event) => setAddRole(event.target.value)}
            aria-label="成员角色"
            className={`${SELECT_CLASS} h-8`}
          >
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABEL[role]}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            onClick={() => addMutation.mutate()}
            disabled={!addUserId || addMutation.isPending}
          >
            加入
          </Button>
        </div>
      </div>
    </section>
  );
}
