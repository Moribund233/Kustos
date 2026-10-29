import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useTranslation } from "react-i18next";

import { api } from "@/lib/api/client";
import { useApiMutation } from "@/lib/api/hooks";

export interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
  isActive: boolean;
}

/** 新建用户：后端允许未认证注册，这里由管理员在实例面直接建号。 */
export function CreateUserDialog() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);

  const createMutation = useApiMutation<void, void>(
    async () => {
      const res = await api.POST("/api/v1/users", {
        body: {
          username: username.trim(),
          email: email.trim(),
          password,
          full_name: fullName.trim() || undefined,
          is_admin: isAdmin,
        } as never,
      });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail;
        throw new Error(detail ?? t("admin.userCreateFailed"));
      }
    },
    {
      onSuccess: async () => {
        toast.success(t("admin.userCreated"));
        setUsername("");
        setEmail("");
        setFullName("");
        setPassword("");
        setIsAdmin(false);
        setOpen(false);
        await queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      },
      onError: (error) => toast.error(error.message),
    },
  );

  return (
    <>
      <Button size="sm" variant="outline" type="button" onClick={() => setOpen(true)}>
        {t("admin.newUser")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[440px]">
          <DialogHeader>
            <DialogTitle>{t("admin.newUser")}</DialogTitle>
            <DialogDescription>{t("admin.newUserHint")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Input value={username} onChange={(event) => setUsername(event.target.value)} placeholder={t("admin.username")} aria-label={t("admin.username")} />
            <Input value={email} onChange={(event) => setEmail(event.target.value)} placeholder={t("auth.email")} aria-label={t("auth.email")} type="email" />
            <Input value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder={t("admin.fullName")} aria-label={t("admin.fullName")} />
            <Input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t("admin.initialPassword")}
              aria-label={t("admin.initialPassword")}
              type="password"
            />
            <label className="text-muted-2 flex items-center gap-2 text-[11px]">
              <input type="checkbox" checked={isAdmin} onChange={(event) => setIsAdmin(event.target.checked)} />
              {t("admin.asAdmin")}
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={!username.trim() || !email.trim() || password.length < 6 || createMutation.isPending}
            >
              {t("common.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** 用户行操作：全局角色、启停、重置密码、删除。 */
export function UserRowActions({ user }: { user: AdminUserRow }) {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const { t } = useTranslation();

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["admin", "users"] });

  const updateMutation = useApiMutation<void, Record<string, unknown>>(
    async (body) => {
      const res = await api.PUT("/api/v1/users/{user_id}", {
        params: { path: { user_id: user.id } },
        body: body as never,
      });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail;
        throw new Error(detail ?? t("admin.userUpdateFailed"));
      }
    },
    {
      onSuccess: async () => {
        toast.success(t("admin.userUpdated"));
        await refresh();
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const resetMutation = useApiMutation<void, void>(
    async () => {
      const res = await api.POST("/api/v1/users/{user_id}/password", {
        params: { path: { user_id: user.id } },
        body: { new_password: password } as never,
      });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail;
        throw new Error(detail ?? t("admin.resetFailed"));
      }
    },
    {
      onSuccess: () => {
        toast.success(t("admin.passwordReset"));
        setPassword("");
        setResetOpen(false);
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const deleteMutation = useApiMutation<void, void>(
    async () => {
      const res = await api.DELETE("/api/v1/users/{user_id}", {
        params: { path: { user_id: user.id } },
      });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail;
        throw new Error(detail ?? t("admin.userDeleteFailed"));
      }
    },
    {
      onSuccess: async () => {
        toast.success(t("admin.userDeleted"));
        await refresh();
      },
      onError: (error) => toast.error(error.message),
    },
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={t("admin.userActionsAria", { name: user.name })} className="text-muted-2 hover:text-bone-2 transition-colors">
            <MoreHorizontal className="size-[14px]" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[180px]">
          <DropdownMenuItem onSelect={() => updateMutation.mutate({ is_admin: !user.isAdmin })}>
            {user.isAdmin ? t("admin.revokeAdmin") : t("admin.makeAdmin")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => updateMutation.mutate({ is_active: !user.isActive })}>
            {user.isActive ? t("admin.deactivate") : t("admin.activate")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setResetOpen(true)}>{t("admin.resetPassword")}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => deleteMutation.mutate()}>{t("common.delete")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent className="max-w-[380px]">
          <DialogHeader>
            <DialogTitle>{t("admin.resetPassword")}</DialogTitle>
            <DialogDescription>{user.name} · {t("admin.resetHint")}</DialogDescription>
          </DialogHeader>
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-label={t("admin.resetPassword")}
            placeholder={t("admin.resetPassword")}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setResetOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => resetMutation.mutate()}
              disabled={password.length < 6 || resetMutation.isPending}
            >
              {t("admin.reset")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
