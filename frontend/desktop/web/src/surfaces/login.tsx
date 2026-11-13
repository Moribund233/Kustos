import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, Input } from "@kustos/ui";

import { useLogin, type Credentials, type Instance } from "@/lib/session";

/**
 * 登录表单。
 *
 * 当前只有密码登录；PKCE 浏览器授权后端已就绪（/auth/pkce/*），
 * 客户端接入后在这里加入口。刻意不做"浏览器继续"的假按钮——
 * 按钮在、点了没反应，比没有按钮更糟。
 *
 * 这是**表单**不是页面：标题、实例切换与外层留白由引导页负责，
 * 因为它要能在"实例还没确认可用"时把整个表单置灰。
 */
export function LoginForm({
  instance,
  disabled,
  onSuccess,
}: {
  instance: Instance;
  /** 实例尚未确认可用：输入框与提交按钮一律置灰。 */
  disabled?: boolean;
  onSuccess: (creds: Credentials) => void;
}) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const login = useLogin();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled || !username || !password) return;

    login.mutate(
      { instanceID: instance.id, username, password },
      {
        onSuccess: ([creds, result]) => {
          if (result.success) onSuccess(creds);
        },
      },
    );
  };

  const result = login.data?.[1];

  return (
    <form onSubmit={submit}>
      <label htmlFor="username" className="mb-1 block text-[11px] text-faint">
        {t("session.username")}
      </label>
      <Input
        id="username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        disabled={disabled}
        autoFocus={!disabled}
        autoComplete="username"
        spellCheck={false}
        className="mb-3"
      />

      <label htmlFor="password" className="mb-1 block text-[11px] text-faint">
        {t("session.password")}
      </label>
      <Input
        id="password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={disabled}
        autoComplete="current-password"
        className="mb-4"
      />

      <Button
        type="submit"
        disabled={disabled || login.isPending || !username || !password}
        className="w-full"
      >
        {login.isPending ? t("session.loggingIn") : t("session.login")}
      </Button>

      {/* 失败原因就地展示且可重试，不用一次性 toast */}
      {result && !result.success && (
        <p className="mt-3 text-[12px] text-[var(--color-rose)]">{result.error}</p>
      )}
      {login.isError && (
        <p className="mt-3 text-[12px] text-[var(--color-rose)]">
          {t("session.addFailed", { error: String(login.error) })}
        </p>
      )}

      {/* 凭据未能进入系统钥匙串时如实告知：否则用户会在重启后莫名被登出 */}
      {login.data?.[0]?.persistent === false && (
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-amber-2)]">
          {t("session.keychainDegraded")}
        </p>
      )}
    </form>
  );
}
