import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { configureAuth, setAccessToken } from "@kustos/api";

import { ConnectInstance } from "@/surfaces/connect-instance";
import {
  InboxDetail,
  InboxInspector,
  InboxList,
  useInbox,
} from "@/surfaces/inbox";
import { Login } from "@/surfaces/login";
import {
  CodeDetail,
  CodeInspector,
  CodeTree,
  useCodeSurface,
} from "@/surfaces/code";
import {
  WorkingCopyDetail,
  WorkingCopyInspector,
  WorkingCopyList,
  useWorkingCopySurface,
} from "@/surfaces/working-copy";
import { FramedNote, WindowFrame } from "@/shell/window-frame";
import {
  Shell,
  SURFACES,
  StatusItem,
  useSurfaceShortcuts,
  type Surface,
} from "@/shell/shell";
import {
  useActiveInstance,
  useInstances,
  useRestoreSession,
  type Credentials,
} from "@/lib/session";
/**
 * 桌面端根组件。
 *
 * 启动顺序：
 *   1. 读实例列表；有则尝试用 Keychain 里的 refresh 恢复会话
 *   2. 无实例 → 连接页
 *   3. 有实例无会话 → 登录页
 *   4. 有会话 → 三栏主界面
 *
 * 恢复失败不报错：refresh 过期/被吊销是常态，直接回登录页即可。
 */

// refresh token 在桌面端只驻内存：持久化由 Go 侧 Keychain 负责。
// 传内存实现是**有意的**——它明确表示 WebView 存储里不该有 refresh token。
configureAuth({
  refreshStore: {
    get: () => null,
    set: () => {
      // 轮换与持久化都在 Go 侧完成。
    },
  },
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 常驻进程：切 surface 不该重新拉取。
      staleTime: 60_000,
      retry: 1,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Root />
    </QueryClientProvider>
  );
}

type Phase = "loading" | "connect" | "login" | "ready";

function Root() {
  const { t } = useTranslation();
  const [surface, setSurface] = useState<Surface>("inbox");
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  // 手动"切换实例"时强制回到连接页，即使已有实例档案。
  const [forceConnect, setForceConnect] = useState(false);

  const instances = useInstances();
  const activeInstance = useActiveInstance();
  const restore = useRestoreSession();

  const instance = activeInstance.data ?? null;

  // 启动时尝试恢复会话。
  useEffect(() => {
    if (phase !== "loading") return;
    if (instances.isLoading) return;

    const list = instances.data ?? [];
    if (list.length === 0) {
      setPhase("connect");
      return;
    }

    // 对已有实例逐个尝试恢复；第一个成功的即接管。
    let cancelled = false;
    void (async () => {
      for (const it of list) {
        const [restored, ok] = await restore.mutateAsync(it.id);
        if (cancelled) return;
        if (ok) {
          setAccessToken(restored.accessToken);
          setCreds(restored);
          setPhase("ready");
          return;
        }
      }
      if (!cancelled) setPhase("login");
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instances.isLoading, instances.data, phase]);

  const handleConnected = useCallback(() => {
    setForceConnect(false);
    setPhase("login");
  }, []);

  const handleLoggedIn = useCallback((c: Credentials) => {
    // access token 进 JS 内存（与 Web 同级风险），refresh 已在 Go 的 Keychain 里。
    setAccessToken(c.accessToken);
    setCreds(c);
    setPhase("ready");
  }, []);

  useSurfaceShortcuts(setSurface, phase === "ready");

  if (phase === "loading") {
    return <FramedNote>{t("session.restoring")}</FramedNote>;
  }

  if (phase === "connect" || forceConnect) {
    return (
      <WindowFrame>
        <ConnectInstance
          onAdded={() => {
            handleConnected();
          }}
        />
      </WindowFrame>
    );
  }

  if (phase === "login") {
    // 活动实例是异步查出来的：首帧必然还没有值。此时若直接回退到连接页，
    // 用户会看到"刚添加成功又被弹回表单"——所以先等这次查询有结果。
    if (activeInstance.isLoading) {
      return <FramedNote>{t("session.preparingLogin")}</FramedNote>;
    }
    // 确实没有活动实例（例如刚启动、还没选）才给连接页。
    if (!instance) {
      return (
        <WindowFrame>
          <ConnectInstance onAdded={handleConnected} />
        </WindowFrame>
      );
    }
    return (
      <WindowFrame>
        <Login
          instance={instance}
          onSuccess={handleLoggedIn}
          onChangeInstance={() => setForceConnect(true)}
        />
      </WindowFrame>
    );
  }

  return (
    <MainShell
      surface={surface}
      onSelect={setSurface}
      creds={creds}
      instanceName={instance?.name ?? ""}
      online={instance != null}
    />
  );
}

/**
 * 主界面：外壳 + 当前 surface。
 *
 * 每个面自己提供 list / detail / inspector 片段，外壳只负责摆放——
 * 三栏骨架是外壳的职责，面的内容是各自的事。
 */
function MainShell({
  surface,
  onSelect,
  creds,
  instanceName,
  online,
}: {
  surface: Surface;
  onSelect: (s: Surface) => void;
  creds: Credentials | null;
  instanceName: string;
  online: boolean;
}) {
  const { t } = useTranslation();
  const inbox = useInbox();
  const wc = useWorkingCopySurface();
  const code = useCodeSurface();

  const conn = online ? "online" : "offline";

  // 标题栏的仓库与分支 chip：原型在这里常驻展示当前上下文，
  // 用户一眼知道"我现在在哪个仓库、哪个分支"。
  // 仓库名取自工作副本路径的最后一段，分支取其实时状态。
  const repoChip = wc.active ? baseNameOf(wc.active.path) : instanceName || t("status.offline");
  const branchChip = wc.status?.branch || "";
  const ahead = wc.status?.ahead ?? 0;
  const behind = wc.status?.behind ?? 0;

  // 收件箱与工作副本已接真实数据；其余面保持骨架。
  if (surface === "inbox") {
    return (
      <Shell
        active={surface}
        onSelect={onSelect}
        conn={conn}
        offline={!online}
        badges={{ inbox: inbox.unreadCount }}
        userName={creds?.username}
        repoChip={repoChip}
        branchChip={branchChip}
        ahead={ahead}
        behind={behind}
        list={<InboxList state={inbox} />}
        detail={<InboxDetail state={inbox} />}
        inspector={<InboxInspector state={inbox} />}
        statusLeft={
          <>
            <StatusItem icon="git-commit">{t("status.noWorkingCopy")}</StatusItem>
            <span className="text-[var(--color-faint)]">·</span>
            <StatusItem icon="pulse" tone={online ? "sage" : "amber"}>
              {online ? t("status.connected") : t("status.offline")}
            </StatusItem>
          </>
        }
        statusRight={
          <>
            <StatusItem icon="bell" tone={inbox.unreadCount > 0 ? "amber" : undefined}>
              {t("status.unread", { count: inbox.unreadCount })}
            </StatusItem>
          </>
        }
      />
    );
  }

  if (surface === "working-copy") {
    const dirty = wc.status?.dirty ?? false;
    return (
      <Shell
        active={surface}
        onSelect={onSelect}
        conn={conn}
        offline={!online}
        badges={{ inbox: inbox.unreadCount }}
        userName={creds?.username}
        repoChip={repoChip}
        branchChip={branchChip}
        ahead={ahead}
        behind={behind}
        list={<WorkingCopyList state={wc} />}
        detail={<WorkingCopyDetail state={wc} />}
        inspector={<WorkingCopyInspector state={wc} />}
        statusLeft={
          <>
            <StatusItem icon="branch">
              <span className="font-mono">{wc.status?.branch || "—"}</span>
            </StatusItem>
            <span className="text-[var(--color-faint)]">·</span>
            <span className={dirty ? "text-[var(--color-amber)]" : ""}>
              {dirty ? t("status.changedFiles", { count: wc.status?.changes.length ?? 0 }) : t("status.clean")}
            </span>
          </>
        }
        statusRight={
          <>
            <StatusItem icon="pulse" tone={online ? "sage" : "amber"}>
              {online ? t("status.connected") : t("status.offline")}
            </StatusItem>
            <span className="text-[var(--color-faint)]">·</span>
            <StatusItem icon="database">{t("status.localGit")}</StatusItem>
          </>
        }
      />
    );
  }

  if (surface === "code") {
    return (
      <Shell
        active={surface}
        onSelect={onSelect}
        conn={conn}
        offline={!online}
        badges={{ inbox: inbox.unreadCount }}
        userName={creds?.username}
        repoChip={code.active ? baseNameOf(code.active.path) : repoChip}
        branchChip={branchChip}
        ahead={ahead}
        behind={behind}
        list={<CodeTree state={code} />}
        detail={<CodeDetail state={code} />}
        inspector={<CodeInspector state={code} />}
        statusLeft={
          <>
            <StatusItem icon="branch">
              <span className="font-mono">{branchChip || "—"}</span>
            </StatusItem>
            <span className="text-[var(--color-faint)]">·</span>
            <StatusItem icon="file">
              {code.activePath ? baseNameOf(code.activePath) : t("code.emptyTitle")}
            </StatusItem>
          </>
        }
        statusRight={
          <>
            <StatusItem icon="pulse" tone={online ? "sage" : "amber"}>
              {online ? t("status.connected") : t("status.offline")}
            </StatusItem>
            <span className="text-[var(--color-faint)]">·</span>
            <StatusItem icon="database">{t("status.localGit")}</StatusItem>
          </>
        }
      />
    );
  }

  const meta = SURFACES.find((s) => s.id === surface) ?? SURFACES[0];
  return (
    <Shell
      active={surface}
      onSelect={onSelect}
      conn={conn}
        offline={!online}
        badges={{ inbox: inbox.unreadCount }}
        userName={creds?.username}
        repoChip={repoChip}
        branchChip={branchChip}
        ahead={ahead}
        behind={behind}
      list={
        <div className="flex h-full flex-col">
          <div className="shrink-0 border-b border-[var(--color-edge-1)] px-3 pt-2.5 pb-2">
            <h1 className="text-[13px] font-medium text-[var(--color-bone)]">{t(meta.i18nKey)}</h1>
          </div>
          <p className="px-3 py-3 text-[11.5px] leading-relaxed text-[var(--color-muted)]">
            {t("surfaces.notImplemented")}
          </p>
        </div>
      }
      detail={
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-[15px] text-[var(--color-bone)]">{t(meta.i18nKey)}</p>
          <p className="max-w-[46ch] text-[12px] leading-relaxed text-[var(--color-muted)]">
            {t("surfaces.notImplemented")} {t("surfaces.signedInAs", { name: creds?.username || "—" })}
          </p>
        </div>
      }
      statusLeft={<StatusItem icon="pulse">{t(meta.i18nKey)}</StatusItem>}
      statusRight={
        <StatusItem icon="pulse" tone={online ? "sage" : "amber"}>
          {online ? t("status.connected") : t("status.offline")}
        </StatusItem>
      }
    />
  );
}

/** 取路径最后一段作为仓库显示名（Windows 与 POSIX 分隔符都处理）。 */
function baseNameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}











