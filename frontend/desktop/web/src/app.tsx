import { useCallback, useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { configureAuth, setAccessToken } from "@kustos/api";

import { ConnectInstance } from "@/surfaces/connect-instance";
import { Inbox } from "@/surfaces/inbox";
import { Login } from "@/surfaces/login";
import { Shell, SURFACES, useSurfaceShortcuts, type Surface } from "@/shell/shell";
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
    return <CenterNote>正在读取本机实例…</CenterNote>;
  }

  if (phase === "connect" || forceConnect) {
    return (
      <ConnectInstance
        onAdded={() => {
          handleConnected();
        }}
      />
    );
  }

  if (phase === "login") {
    // 活动实例是异步查出来的：首帧必然还没有值。此时若直接回退到连接页，
    // 用户会看到"刚添加成功又被弹回表单"——所以先等这次查询有结果。
    if (activeInstance.isLoading) {
      return <CenterNote>正在准备登录…</CenterNote>;
    }
    // 确实没有活动实例（例如刚启动、还没选）才给连接页。
    if (!instance) {
      return <ConnectInstance onAdded={handleConnected} />;
    }
    return (
      <Login
        instance={instance}
        onSuccess={handleLoggedIn}
        onChangeInstance={() => setForceConnect(true)}
      />
    );
  }

  return (
    <MainShell
      surface={surface}
      onSelect={setSurface}
      creds={creds}
      instanceName={instance?.name ?? ""}
    />
  );
}

/** 主界面三栏。 */
function MainShell({
  surface,
  onSelect,
  creds,
  instanceName,
}: {
  surface: Surface;
  onSelect: (s: Surface) => void;
  creds: Credentials | null;
  instanceName: string;
}) {
  const meta = useMemo(() => SURFACES.find((s) => s.id === surface) ?? SURFACES[0], [surface]);
  const [unreadCount, setUnreadCount] = useState(0);

  const titleContext = (
    <span className="text-[11px] text-muted">{instanceName || "未连接实例"}</span>
  );
  const statusLeft = <span>无工作副本</span>;
  const statusRight = (
    <>
      <span>在线 —</span>
      <span>待发 0</span>
    </>
  );

  // 收件箱是唯一已经接上真实数据的面；其余面仍是骨架。
  if (surface === "inbox") {
    return (
      <Inbox onUnreadCount={setUnreadCount}>
        {({ list, detail }) => (
          <Shell
            active={surface}
            onSelect={onSelect}
            titleContext={titleContext}
            list={list}
            detail={detail}
            statusLeft={statusLeft}
            statusRight={
              <>
                <span>在线 —</span>
                <span>未读 {unreadCount}</span>
              </>
            }
          />
        )}
      </Inbox>
    );
  }

  return (
    <Shell
      active={surface}
      onSelect={onSelect}
      titleContext={titleContext}
      list={
        <div className="p-3">
          <h2 className="mb-2 text-[11px] font-medium tracking-wide text-faint uppercase">
            {meta.label}
          </h2>
          <p className="text-[12px] leading-relaxed text-muted">
            已登录为 {creds?.username || "—"}。
          </p>
        </div>
      }
      detail={
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="font-display text-lg text-bone">{meta.label}</p>
          <p className="max-w-[42ch] text-[12px] leading-relaxed text-muted">
            这一面还没接入。收件箱已经可用，其余面按里程碑逐个落地。
          </p>
        </div>
      }
      statusLeft={statusLeft}
      statusRight={statusRight}
    />
  );
}

function CenterNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-[12px] text-muted">{children}</p>
    </div>
  );
}
