import { useEffect, useRef, useState, type ReactNode } from "react";
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

const PREF_LABELS: { key: keyof NotificationPreference; label: string }[] = [
  { key: "email_on_mention", label: "邮件：被 @ 提及" },
  { key: "email_on_pr_review", label: "邮件：PR 评审" },
  { key: "email_on_issue_comment", label: "邮件：Issue 评论" },
  { key: "email_on_pr_merge", label: "邮件：PR 合并" },
  { key: "email_on_release", label: "邮件：发布版本" },
  { key: "in_app_on_mention", label: "站内：被 @ 提及" },
  { key: "in_app_on_pr_review", label: "站内：PR 评审" },
  { key: "in_app_on_issue_comment", label: "站内：Issue 评论" },
];

/**
 * 账号设置页：资料、头像、密码、SSH 密钥、通知偏好、第三方账号。
 *
 * 后端把「当前用户」的操作都放在 `/users/me/*` 与 `/keys`；资料更新走
 * `PUT /users/{id}`（后端允许本人改自己的字段）。邮箱、用户名冲突由后端裁决。
 */
export function AccountPage() {
  const setCrumbs = useUiStore((state) => state.setCrumbs);
  const username = useAuthStore((state) => state.user?.username);

  useEffect(() => {
    setCrumbs([{ label: "账号" }, { label: "资料与偏好" }]);
  }, [setCrumbs]);

  return (
    <div className="mx-auto w-full max-w-[860px] px-[34px] pt-[30px] pb-20">
      <header className="mb-6">
        <p className="text-faint text-[10.5px] font-semibold tracking-[0.16em] uppercase">
          Account
        </p>
        <h1 className="font-display text-bone mt-1.5 text-[clamp(1.7rem,2.6vw,2.3rem)] leading-none font-medium tracking-[-0.028em]">
          资料与偏好
        </h1>
        <p className="text-muted-2 mt-2 text-[11.5px]">
          当前登录 <span className="font-mono">{username ?? "—"}</span>
          。密码、密钥等敏感操作只作用于你自己。
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
      <h2 className="text-bone text-[13px] font-semibold">{title}</h2>
      {hint ? <p className="text-muted-2 mt-1 text-[11px]">{hint}</p> : null}
      <div className="mt-4 flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-muted-2 text-[10px] font-semibold tracking-[0.13em] uppercase">
        {label}
      </span>
      {children}
    </label>
  );
}

/** 资料与头像：字段少，整表单提交；成功后刷新会话里的用户信息。 */
function ProfileSection() {
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
        throw new Error(detail ?? "保存失败。");
      }
      await reloadMe();
    },
    {
      onSuccess: () => toast.success("资料已保存。"),
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
      toast.error("头像上传失败。");
      return;
    }
    toast.success("头像已更新。");
    await reloadMe();
  };

  return (
    <Section title="资料" hint="用户名与邮箱需在实例内唯一；改名会影响克隆地址里的用户名部分。">
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
          <span className="text-muted-2 text-[10.5px]">头像（JPEG / PNG / GIF / WebP，≤5 MB）</span>
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
              选择图片
            </Button>
          </div>
        </div>
      </div>
      <Field label="全名">
        <Input
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
          aria-label="全名"
        />
      </Field>
      <Field label="邮箱">
        <Input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-label="邮箱"
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
          {saveMutation.isPending ? "保存中…" : "保存"}
        </Button>
      </div>
    </Section>
  );
}

/** 修改密码：两次新密码一致才提交，后端会校验旧密码。 */
function PasswordSection() {
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
        throw new Error(detail ?? "修改密码失败。");
      }
    },
    {
      onSuccess: () => {
        toast.success("密码已修改。");
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
    <Section title="密码" hint="新密码至少 6 位；修改后其他会话不会自动退出。">
      <Field label="当前密码">
        <Input
          type="password"
          value={oldPassword}
          onChange={(event) => setOldPassword(event.target.value)}
          aria-label="当前密码"
          autoComplete="current-password"
        />
      </Field>
      <Field label="新密码">
        <Input
          type="password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          aria-label="新密码"
          autoComplete="new-password"
        />
      </Field>
      <Field label="确认新密码">
        <Input
          type="password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          aria-label="确认新密码"
          autoComplete="new-password"
        />
      </Field>
      {mismatch ? <p className="text-rose text-[11px]">两次输入的新密码不一致。</p> : null}
      <div className="border-edge-1 flex items-center gap-2 border-t pt-4">
        <Button
          size="sm"
          onClick={() => mutation.mutate()}
          disabled={!canSubmit || mutation.isPending}
        >
          {mutation.isPending ? "提交中…" : "修改密码"}
        </Button>
      </div>
    </Section>
  );
}

/** SSH 公钥：只保存公钥，指纹由后端计算。 */
function SshKeySection() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [publicKey, setPublicKey] = useState("");

  const listQuery = useApiQuery<SshKey[]>({
    queryKey: ["ssh-keys"],
    queryFn: async () => {
      const res = await api.GET("/api/v1/keys");
      if (res.error) throw new Error("加载 SSH 密钥失败。");
      return (res.data as unknown as SshKey[]) ?? [];
    },
  });

  const addMutation = useApiMutation<void, { name: string; public_key: string }>(
    async (input) => {
      const res = await api.POST("/api/v1/keys", { body: input as never });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail;
        throw new Error(detail ?? "添加密钥失败。");
      }
    },
    {
      onSuccess: async () => {
        toast.success("SSH 密钥已添加。");
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
      if (res.error) throw new Error("删除密钥失败。");
    },
    {
      onSuccess: async () => {
        toast.success("SSH 密钥已删除。");
        await queryClient.invalidateQueries({ queryKey: ["ssh-keys"] });
      },
      onError: (error) => toast.error(error.message),
    },
  );

  return (
    <Section title="SSH 密钥" hint="用于 git clone / push 的 SSH 访问；服务端只保存公钥。">
      {listQuery.isLoading ? (
        <p className="text-muted-2 text-[11.5px]">加载中…</p>
      ) : (listQuery.data ?? []).length === 0 ? (
        <p className="text-muted-2 text-[11.5px]">还没有密钥。</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {(listQuery.data ?? []).map((key) => (
            <li
              key={key.id}
              className="border-edge-1 flex items-center gap-3 rounded-md border px-3 py-2"
            >
              <KeyRound className="text-muted-2 size-[14px] shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="text-bone-2 block truncate text-[12px] font-medium">
                  {key.name}
                </span>
                <span className="text-faint block truncate font-mono text-[10px]">
                  {key.fingerprint}
                </span>
              </span>
              <span className="text-faint text-[10px]">{formatRelative(key.created_at)}</span>
              <button
                type="button"
                aria-label={`删除 ${key.name}`}
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
          placeholder="密钥名称（如 work laptop）"
          aria-label="密钥名称"
        />
        <textarea
          value={publicKey}
          onChange={(event) => setPublicKey(event.target.value)}
          rows={3}
          placeholder="ssh-ed25519 AAAA… user@host"
          aria-label="公钥内容"
          className="border-edge-2 bg-ink-950/60 text-bone placeholder:text-muted-2 focus:border-amber/40 min-h-[70px] w-full resize-none rounded-md border px-2.5 py-2 font-mono text-[11px] transition-colors outline-none"
        />
        <Button
          size="sm"
          className="self-start"
          onClick={() => addMutation.mutate({ name: name.trim(), public_key: publicKey.trim() })}
          disabled={!name.trim() || !publicKey.trim() || addMutation.isPending}
        >
          <Plus className="size-[13px]" aria-hidden="true" />
          {addMutation.isPending ? "添加中…" : "添加密钥"}
        </Button>
      </div>
    </Section>
  );
}

/** 通知偏好：开关即时保存，保存后重拉一次以服务端值为准。 */
function NotificationSection() {
  const queryClient = useQueryClient();

  const prefsQuery = useApiQuery<NotificationPreference>({
    queryKey: ["notification-preferences"],
    queryFn: async () => {
      const res = await api.GET("/api/v1/notifications/preferences");
      if (res.error) throw new Error("加载通知偏好失败。");
      return res.data as unknown as NotificationPreference;
    },
  });

  const updateMutation = useApiMutation<void, Partial<NotificationPreference>>(
    async (patch) => {
      const res = await api.PUT("/api/v1/notifications/preferences", { body: patch as never });
      if (res.error) throw new Error("保存通知偏好失败。");
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
    <Section title="通知偏好" hint="邮件通知需要实例已配置 SMTP；站内通知始终走通知中心。">
      {!prefs ? (
        <p className="text-muted-2 text-[11.5px]">
          {prefsQuery.isLoading ? "加载中…" : "读取失败。"}
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {PREF_LABELS.map(({ key, label }) => (
            <label
              key={key}
              className="border-edge-1 flex items-center justify-between gap-3 rounded-md border px-3 py-2"
            >
              <span className="text-muted text-[11.5px]">{label}</span>
              <Switch
                checked={prefs[key]}
                disabled={updateMutation.isPending}
                onCheckedChange={(checked) => updateMutation.mutate({ [key]: checked })}
                aria-label={label}
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
  const queryClient = useQueryClient();

  const accountsQuery = useApiQuery<LinkedAccount[]>({
    queryKey: ["oauth-accounts"],
    queryFn: async () => {
      const res = await api.GET("/api/v1/users/me/oauth");
      if (res.error) throw new Error("加载第三方账号失败。");
      return (res.data as unknown as LinkedAccount[]) ?? [];
    },
  });

  const unlinkMutation = useApiMutation<void, string>(
    async (provider) => {
      const res = await api.DELETE("/api/v1/users/me/oauth/{provider}", {
        params: { path: { provider } },
      });
      if (res.error) throw new Error("解绑失败。");
    },
    {
      onSuccess: async () => {
        toast.success("已解绑。");
        await queryClient.invalidateQueries({ queryKey: ["oauth-accounts"] });
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const accounts = accountsQuery.data ?? [];

  return (
    <Section
      title="第三方账号"
      hint="绑定的 GitHub / GitLab 账号可用于登录；解绑后只能用密码登录。"
    >
      {accounts.length === 0 ? (
        <p className="text-muted-2 text-[11.5px]">
          {accountsQuery.isLoading ? "加载中…" : "还没有绑定第三方账号。"}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {accounts.map((account) => (
            <li
              key={account.provider}
              className="border-edge-1 flex items-center gap-3 rounded-md border px-3 py-2"
            >
              <span className="text-bone-2 flex-1 text-[12px] font-medium capitalize">
                {account.provider}
              </span>
              <span className="text-faint font-mono text-[10.5px]">
                {account.provider_username ?? "—"}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => unlinkMutation.mutate(account.provider)}
                disabled={unlinkMutation.isPending}
              >
                解绑
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
