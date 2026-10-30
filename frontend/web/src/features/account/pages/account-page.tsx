import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ToneAvatar } from "@/components/kit/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api, getAccessToken } from "@/lib/api/client";
import { useApiMutation, useApiQuery } from "@/lib/api/hooks";
import { formatRelative } from "@/lib/datetime/format";
import { useAuthStore } from "@/stores/auth-store";
import { useUiStore } from "@/stores/ui-store";

/** GET /api/v1/keys 的列表项（key_controller.SSHKeyResponse）。 */
interface SshKey {
  id: string;
  name: string;
  public_key: string;
  fingerprint: string;
  created_at: string;
}

/** GET /api/v1/notifications/preferences（notification_preference_service 的字段）。 */
interface NotificationPreference {
  email_on_mention: boolean;
  email_on_pr_review: boolean;
  email_on_issue_comment: boolean;
  email_on_pr_merge: boolean;
  email_on_release: boolean;
  in_app_on_mention: boolean;
  in_app_on_pr_review: boolean;
  in_app_on_issue_comment: boolean;
}

/** GET /api/v1/users/me/oauth 的列表项。 */
interface LinkedAccount {
  provider: string;
  provider_username: string | null;
  created_at: string | null;
}

const PREF_LABELS: { key: keyof NotificationPreference; labelKey: string }[] = [
  { key: "email_on_mention", labelKey: "account.prefEmailMention" },
  { key: "email_on_pr_review", labelKey: "account.prefEmailReview" },
  { key: "email_on_issue_comment", labelKey: "account.prefEmailComment" },
  { key: "email_on_pr_merge", labelKey: "account.prefEmailMerge" },
  { key: "email_on_release", labelKey: "account.prefEmailRelease" },
  { key: "in_app_on_mention", labelKey: "account.prefInAppMention" },
  { key: "in_app_on_pr_review", labelKey: "account.prefInAppReview" },
  { key: "in_app_on_issue_comment", labelKey: "account.prefInAppComment" },
];

/**
 * 账号设置页：资料、头像、密码、SSH 密钥、通知偏好、第三方账号。
 *
 * 后端把「当前用户」的操作都放在 `/users/me/*` 与 `/keys`；资料更新走
 * `PUT /users/{id}`（后端允许本人改自己的字段）。邮箱、用户名冲突由后端裁决。
 */
export function AccountPage() {
  const { t } = useTranslation();
  const setCrumbs = useUiStore((state) => state.setCrumbs);
  const username = useAuthStore((state) => state.user?.username);

  useEffect(() => {
    setCrumbs([{ label: t("account.kicker") }, { label: t("account.title") }]);
  }, [setCrumbs, t]);

  return (
    <div className="mx-auto w-full max-w-[860px] px-[34px] pt-[30px] pb-20">
      <header className="mb-6">
        <p className="text-faint text-xs font-semibold tracking-[0.16em] uppercase">
          {t("account.kicker")}
        </p>
        <h1 className="font-display text-bone mt-1.5 text-[clamp(1.7rem,2.6vw,2.3rem)] leading-none font-medium tracking-[-0.028em]">
          {t("account.title")}
        </h1>
        <p className="text-muted-2 mt-2 text-xs">
          {t("account.currentUser")} <span className="font-mono">{username ?? "—"}</span>{" "}
          · {t("account.sensitiveHint")}
        </p>
      </header>

      <div className="flex flex-col gap-4">
        <ProfileSection />
        <PasswordSection />
        <SshKeySection />
        <NotificationSection />
        <OAuthSection />
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="border-edge-2 bg-ink-900/50 rounded-[12px] border p-5">
      <h2 className="text-bone text-base font-semibold">{title}</h2>
      {hint ? <p className="text-muted-2 mt-1 text-xs">{hint}</p> : null}
      <div className="mt-4 flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-muted-2 text-2xs font-semibold tracking-[0.13em] uppercase">
        {label}
      </span>
      {children}
    </label>
  );
}

/** 资料与头像：字段少，整表单提交；成功后刷新会话里的用户信息。 */
function ProfileSection() {
  const { t } = useTranslation();
  const user = useAuthStore((state) => state.user);
  const reloadMe = useAuthStore((state) => state.reloadMe);
  const [fullName, setFullName] = useState(user?.full_name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  const saveMutation = useApiMutation<void, { full_name: string; email: string }>(
    async (input) => {
      const res = await api.PUT("/api/v1/users/{user_id}", {
        params: { path: { user_id: user?.id ?? "" } },
        body: input as never,
      });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail;
        throw new Error(detail ?? t("account.saveFailed"));
      }
      await reloadMe();
    },
    {
      onSuccess: () => toast.success(t("account.saved")),
      onError: (error) => toast.error(error.message),
    },
  );

  /** 头像走 multipart，openapi 客户端只拼 JSON，和 Release 附件一样用原生 fetch。 */
  const uploadAvatar = async (file: File) => {
    const token = getAccessToken();
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/v1/users/me/avatar", {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: form,
    });
    if (!res.ok) {
      toast.error(t("account.avatarFailed"));
      return;
    }
    toast.success(t("account.avatarUpdated"));
    await reloadMe();
  };

  return (
    <Section title={t("account.profile")} hint={t("account.profileHint")}>
      <div className="flex items-center gap-3">
        {user?.avatar_url ? (
          <img
            src={user.avatar_url}
            alt=""
            className="border-edge-2 size-12 rounded-full border object-cover"
          />
        ) : (
          <ToneAvatar
            initials={(user?.full_name || user?.username || "?").slice(0, 2).toUpperCase()}
            tone="amber"
            size="md"
          />
        )}
        <div className="flex flex-col gap-1">
          <span className="text-muted-2 text-xs">{t("account.avatarHint")}</span>
          <div className="flex items-center gap-2">
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void uploadAvatar(file);
              }}
            />
            <Button size="sm" variant="ghost" onClick={() => avatarInputRef.current?.click()}>
              {t("account.chooseImage")}
            </Button>
          </div>
        </div>
      </div>
      <Field label={t("account.fullName")}>
        <Input
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
          aria-label={t("account.fullName")}
        />
      </Field>
      <Field label={t("account.email")}>
        <Input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-label={t("account.email")}
        />
      </Field>
      <div className="border-edge-1 flex items-center gap-2 border-t pt-4">
        <Button
          size="sm"
          onClick={() => saveMutation.mutate({ full_name: fullName.trim(), email: email.trim() })}
          disabled={
            saveMutation.isPending ||
            (fullName === (user?.full_name ?? "") && email === (user?.email ?? ""))
          }
        >
          {saveMutation.isPending ? t("common.saving") : t("common.save")}
        </Button>
      </div>
    </Section>
  );
}

/** 修改密码：两次新密码一致才提交，后端会校验旧密码。 */
function PasswordSection() {
  const { t } = useTranslation();
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const mutation = useApiMutation<void, void>(
    async () => {
      const res = await api.POST("/api/v1/users/me/password", {
        body: { old_password: oldPassword, new_password: newPassword },
      });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail;
        throw new Error(detail ?? t("account.passwordFailed"));
      }
    },
    {
      onSuccess: () => {
        toast.success(t("account.passwordChanged"));
        setOldPassword("");
        setNewPassword("");
        setConfirm("");
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const mismatch = confirm.length > 0 && confirm !== newPassword;
  const canSubmit = oldPassword.length > 0 && newPassword.length >= 6 && confirm === newPassword;

  return (
    <Section title={t("account.password")} hint={t("account.passwordHint")}>
      <Field label={t("account.currentPassword")}>
        <Input
          type="password"
          value={oldPassword}
          onChange={(event) => setOldPassword(event.target.value)}
          aria-label={t("account.currentPassword")}
          autoComplete="current-password"
        />
      </Field>
      <Field label={t("account.newPassword")}>
        <Input
          type="password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          aria-label={t("account.newPassword")}
          autoComplete="new-password"
        />
      </Field>
      <Field label={t("account.confirmPassword")}>
        <Input
          type="password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          aria-label={t("account.confirmPassword")}
          autoComplete="new-password"
        />
      </Field>
      {mismatch ? <p className="text-rose text-xs">{t("account.mismatch")}</p> : null}
      <div className="border-edge-1 flex items-center gap-2 border-t pt-4">
        <Button
          size="sm"
          onClick={() => mutation.mutate()}
          disabled={!canSubmit || mutation.isPending}
        >
          {mutation.isPending ? t("common.saving") : t("account.changePassword")}
        </Button>
      </div>
    </Section>
  );
}

/** SSH 公钥：只保存公钥，指纹由后端计算。 */
function SshKeySection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [publicKey, setPublicKey] = useState("");

  const listQuery = useApiQuery<SshKey[]>({
    queryKey: ["ssh-keys"],
    queryFn: async () => {
      const res = await api.GET("/api/v1/keys");
      if (res.error) throw new Error(t("account.keyLoadFailed"));
      return (res.data as unknown as SshKey[]) ?? [];
    },
  });

  const addMutation = useApiMutation<void, { name: string; public_key: string }>(
    async (input) => {
      const res = await api.POST("/api/v1/keys", { body: input as never });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail;
        throw new Error(detail ?? t("account.keyFailed"));
      }
    },
    {
      onSuccess: async () => {
        toast.success(t("account.keyAdded"));
        setName("");
        setPublicKey("");
        await queryClient.invalidateQueries({ queryKey: ["ssh-keys"] });
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const deleteMutation = useApiMutation<void, string>(
    async (keyId) => {
      const res = await api.DELETE("/api/v1/keys/{key_id}", {
        params: { path: { key_id: keyId } },
      });
      if (res.error) throw new Error(t("account.keyDeleteFailed"));
    },
    {
      onSuccess: async () => {
        toast.success(t("account.keyDeleted"));
        await queryClient.invalidateQueries({ queryKey: ["ssh-keys"] });
      },
      onError: (error) => toast.error(error.message),
    },
  );

  return (
    <Section title={t("account.sshKeys")} hint={t("account.sshHint")}>
      {listQuery.isLoading ? (
        <p className="text-muted-2 text-xs">{t("common.loading")}</p>
      ) : (listQuery.data ?? []).length === 0 ? (
        <p className="text-muted-2 text-xs">{t("account.noKeys")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {(listQuery.data ?? []).map((key) => (
            <li
              key={key.id}
              className="border-edge-1 flex items-center gap-3 rounded-md border px-3 py-2"
            >
              <KeyRound className="text-muted-2 size-[14px] shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="text-bone-2 block truncate text-sm font-medium">
                  {key.name}
                </span>
                <span className="text-faint block truncate font-mono text-2xs">
                  {key.fingerprint}
                </span>
              </span>
              <span className="text-faint text-2xs">{formatRelative(key.created_at)}</span>
              <button
                type="button"
                aria-label={t("common.delete")}
                className="text-muted-2 hover:text-rose transition-colors"
                onClick={() => deleteMutation.mutate(key.id)}
              >
                <Trash2 className="size-[14px]" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="border-edge-1 flex flex-col gap-2 border-t pt-4">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("account.keyName")}
          aria-label={t("account.keyName")}
        />
        <textarea
          value={publicKey}
          onChange={(event) => setPublicKey(event.target.value)}
          rows={3}
          placeholder="ssh-ed25519 AAAA… user@host"
          aria-label={t("account.publicKey")}
          className="border-edge-2 bg-ink-950/60 text-bone placeholder:text-muted-2 focus:border-amber/40 min-h-[70px] w-full resize-none rounded-md border px-2.5 py-2 font-mono text-xs transition-colors focus-visible:outline-none"
        />
        <Button
          size="sm"
          className="self-start"
          onClick={() => addMutation.mutate({ name: name.trim(), public_key: publicKey.trim() })}
          disabled={!name.trim() || !publicKey.trim() || addMutation.isPending}
        >
          <Plus className="size-[13px]" aria-hidden="true" />
          {addMutation.isPending ? t("common.loading") : t("account.addKey")}
        </Button>
      </div>
    </Section>
  );
}

/** 通知偏好：开关即时保存，保存后重拉一次以服务端值为准。 */
function NotificationSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const prefsQuery = useApiQuery<NotificationPreference>({
    queryKey: ["notification-preferences"],
    queryFn: async () => {
      const res = await api.GET("/api/v1/notifications/preferences");
      if (res.error) throw new Error(t("account.readFailed"));
      return res.data as unknown as NotificationPreference;
    },
  });

  const updateMutation = useApiMutation<void, Partial<NotificationPreference>>(
    async (patch) => {
      const res = await api.PUT("/api/v1/notifications/preferences", { body: patch as never });
      if (res.error) throw new Error(t("account.prefSaveFailed"));
    },
    {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: ["notification-preferences"] });
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const prefs = prefsQuery.data;

  return (
    <Section title={t("account.notifications")} hint={t("account.notificationsHint")}>
      {!prefs ? (
        <p className="text-muted-2 text-xs">
          {prefsQuery.isLoading ? t("common.loading") : t("account.readFailed")}
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {PREF_LABELS.map(({ key, labelKey }) => (
            <label
              key={key}
              className="border-edge-1 flex items-center justify-between gap-3 rounded-md border px-3 py-2"
            >
              <span className="text-muted text-xs">{t(labelKey)}</span>
              <Switch
                checked={prefs[key]}
                disabled={updateMutation.isPending}
                onCheckedChange={(checked) => updateMutation.mutate({ [key]: checked })}
                aria-label={t(labelKey)}
              />
            </label>
          ))}
        </div>
      )}
    </Section>
  );
}

/** 第三方账号：只做查看与解绑，绑定入口在登录页（OAuth 登录会复用/建立关联）。 */
function OAuthSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const accountsQuery = useApiQuery<LinkedAccount[]>({
    queryKey: ["oauth-accounts"],
    queryFn: async () => {
      const res = await api.GET("/api/v1/users/me/oauth");
      if (res.error) throw new Error(t("account.oauthLoadFailed"));
      return (res.data as unknown as LinkedAccount[]) ?? [];
    },
  });

  const unlinkMutation = useApiMutation<void, string>(
    async (provider) => {
      const res = await api.DELETE("/api/v1/users/me/oauth/{provider}", {
        params: { path: { provider } },
      });
      if (res.error) throw new Error(t("account.unlinkFailed"));
    },
    {
      onSuccess: async () => {
        toast.success(t("account.unlinked"));
        await queryClient.invalidateQueries({ queryKey: ["oauth-accounts"] });
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const accounts = accountsQuery.data ?? [];

  return (
    <Section
      title={t("account.oauth")}
      hint={t("account.oauthHint")}
    >
      {accounts.length === 0 ? (
        <p className="text-muted-2 text-xs">
          {accountsQuery.isLoading ? t("common.loading") : t("account.noOauth")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {accounts.map((account) => (
            <li
              key={account.provider}
              className="border-edge-1 flex items-center gap-3 rounded-md border px-3 py-2"
            >
              <span className="text-bone-2 flex-1 text-sm font-medium capitalize">
                {account.provider}
              </span>
              <span className="text-faint font-mono text-xs">
                {account.provider_username ?? "—"}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => unlinkMutation.mutate(account.provider)}
                disabled={unlinkMutation.isPending}
              >
                {t("account.unlink")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
