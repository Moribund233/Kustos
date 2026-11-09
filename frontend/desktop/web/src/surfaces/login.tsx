import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, Input } from "@kustos/ui";

import { useLogin, type Credentials, type Instance } from "@/lib/session";

/**
 * 登录。
 *
 * 当前只有密码登录；PKCE 浏览器授权后端已就绪（/auth/pkce/*），
 * 客户端接入后在这里加入口。刻意不做"浏览器继续"的假按钮——
 * 按钮在、点了没反应，比没有按钮更糟。
 */
export function Login({
  instance,
  onSuccess,
  onChangeInstance,
}: {
  instance: Instance;
  onSuccess: (creds: Credentials) => void;
  onChangeInstance: () => void;
}) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const login = useLogin();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) return;

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
    <div className="flex flex-1 items-center justify-center p-8">
      <form onSubmit={submit} className="w-full max-w-[380px]">
        <div className="mb-5">
          <h1 className="font-display mb-1 text-lg text-bone">{t("session.loginTitle")} {instance.name || instance.baseUrl}</h1>
          <button
            type="button"
            onClick={onChangeInstance}
            className="text-[11px] text-faint underline-offset-2 hover:text-bone hover:underline"
          >{t("session.switchInstance")}</button>
        </div>

        <label htmlFor="username" className="mb-1 block text-[11px] text-faint">{t("session.username")}</label>
        <Input
          id="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          autoComplete="username"
          spellCheck={false}
          className="mb-3"
        />

        <label htmlFor="password" className="mb-1 block text-[11px] text-faint">{t("session.password")}</label>
        <Input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          className="mb-4"
        />

        <Button type="submit" disabled={login.isPending || !username || !password} className="w-full">
          {login.isPending ? t("session.loggingIn") : t("session.login")}
        </Button>

        {/* 失败原因就地展示且可重试，不用一次性 toast */}
        {result && !result.success && (
          <p className="mt-3 text-[12px] text-[var(--color-rose)]">{result.error}</p>
        )}
        {login.isError && (
          <p className="mt-3 text-[12px] text-[var(--color-rose)]">{t("session.addFailed", { error: String(login.error) })}</p>
        )}

        {/* 凭据未能进入系统钥匙串时如实告知：否则用户会在重启后莫名被登出 */}
        {login.data?.[0]?.persistent === false && (
          <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-amber-2)]">
            {t("session.keychainDegraded")}
          </p>
        )}
      </form>
    </div>
  );
}



