import { useCallback, useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { configureAuth, setAccessToken } from "@kustos/api";
import { Button, Input } from "@kustos/ui";

import { ConnectInstance } from "@/surfaces/connect-instance";
import { Inbox } from "@/surfaces/inbox";
import { Login } from "@/surfaces/login";
import { WorkingCopyView } from "@/surfaces/working-copy";
import { Shell, SURFACES, useSurfaceShortcuts, type Surface } from "@/shell/shell";
import {
  useActiveInstance,
  useInstances,
  useRestoreSession,
  type Credentials,
} from "@/lib/session";
import {
  useAddWorkingCopy,
  useWorkingCopies,
  useWorkingCopyStatus,
} from "@/lib/working-copy";

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

  if (surface === "working-copy") {
    return <WorkingCopySurface onSelect={onSelect} titleContext={titleContext} />;
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

/**
 * 工作副本面：仓库选择 + 状态查询 + 添加入口。
 *
 * 把"选哪个仓库"与"这个仓库的状态"放在这一层：`WorkingCopyView` 只负责
 * 呈现与暂存提交操作，不该同时管理仓库列表的查询。
 */
function WorkingCopySurface({
  onSelect,
  titleContext,
}: {
  onSelect: (s: Surface) => void;
  titleContext: React.ReactNode;
}) {
  const copies = useWorkingCopies();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addPath, setAddPath] = useState("");
  const addCopy = useAddWorkingCopy();

  const list = copies.data ?? [];
  const active = list.find((c) => c.id === activeId) ?? list[0] ?? null;
  const status = useWorkingCopyStatus(active?.id ?? null);

  // 收敛成视图层的形状：绑定的字段不该漏进 surface 组件。
  const statusForView = status.data
    ? {
        branch: status.data.branch,
        dirty: status.data.dirty,
        ahead: status.data.ahead,
        behind: status.data.behind,
        changes: (status.data.changes ?? []).map((c) => ({
          path: c.path,
          origPath: c.origPath,
          kind: c.kind,
          staged: c.staged,
        })),
      }
    : null;

  // WorkingCopyView 渲染成两个片段（变更列表 + diff），由这里摆进三栏。
  // 只实例化一次：提交信息与暂存侧选择是它内部的状态，两个实例会各存一份。
  return (
    <WorkingCopyView
      workingCopyId={active?.id ?? null}
      status={statusForView}
      loading={status.isLoading}
      error={status.error}
      selectedPath={selectedPath}
      onSelectPath={setSelectedPath}
    >
      {({ changesList, detail }) => (
        <Shell
          active="working-copy"
          onSelect={onSelect}
          titleContext={titleContext}
          list={
            <div className="flex h-full flex-col">
              <div className="shrink-0 border-b border-[var(--color-edge-1)] px-3 py-2">
                <div className="mb-1.5 flex items-center gap-2">
                  <h2 className="text-[11px] font-medium tracking-wide text-faint uppercase">
                    工作副本
                  </h2>
                  <div className="flex-1" />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => setAdding((v) => !v)}
                  >
                    添加
                  </Button>
                </div>
                {adding && (
                  <div className="flex gap-1">
                    <Input
                      value={addPath}
                      onChange={(e) => setAddPath(e.target.value)}
                      placeholder="/path/to/repo"
                      className="h-6 text-[11px]"
                      autoFocus
                    />
                    <Button
                      size="sm"
                      className="h-6 shrink-0 px-2 text-[11px]"
                      disabled={addPath.trim() === "" || addCopy.isPending}
                      onClick={() =>
                        addCopy.mutate(addPath.trim(), {
                          onSuccess: (wc) => {
                            setAddPath("");
                            setAdding(false);
                            setActiveId(wc.id);
                            setSelectedPath(null);
                          },
                        })
                      }
                    >
                      加入
                    </Button>
                  </div>
                )}
                {addCopy.isError && (
                  <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-rose)]">
                    {addCopy.error instanceof Error ? addCopy.error.message : "添加失败"}
                  </p>
                )}
              </div>

              {/* 仓库列表：多仓库并存是常态，切仓库不该离开这一面。 */}
              <div className="max-h-[30%] shrink-0 overflow-auto border-b border-[var(--color-edge-1)]">
                {list.length === 0 && !adding && (
                  <p className="px-3 py-3 text-[11px] leading-relaxed text-muted">
                    还没有仓库。点「添加」填入本地 git 仓库路径。
                  </p>
                )}
                {list.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      setActiveId(c.id);
                      setSelectedPath(null);
                    }}
                    className={[
                      "flex w-full items-center gap-2 border-b border-[var(--color-edge-1)] px-3 py-1.5 text-left",
                      c.id === active?.id
                        ? "bg-[var(--color-ink-800)]"
                        : "hover:bg-[var(--color-ink-850)]",
                    ].join(" ")}
                  >
                    <span className="min-w-0 flex-1 truncate text-[12px] text-bone">
                      {c.path.split(/[\\/]/).pop() || c.path}
                    </span>
                    {c.dirty && (
                      <span className="shrink-0 text-[10px] text-[var(--color-amber-500)]">●</span>
                    )}
                  </button>
                ))}
              </div>

              {/* 变更列表 + 提交框。 */}
              <div className="min-h-0 flex-1">{changesList}</div>
            </div>
          }
          detail={detail}
          statusLeft={<span>{active ? active.branch || "—" : "未选择仓库"}</span>}
          statusRight={
            <>
              <span>{status.data?.dirty ? "未提交" : "干净"}</span>
              <span>
                ↑{status.data?.ahead ?? 0} ↓{status.data?.behind ?? 0}
              </span>
            </>
          }
        />
      )}
    </WorkingCopyView>
  );
}

function CenterNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-[12px] text-muted">{children}</p>
    </div>
  );
}
