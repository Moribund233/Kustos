import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { configureAuth, setAccessToken } from "@kustos/api";
import { WorkingCopyService } from "@/bindings/github.com/kustos/kustos-desktop/internal/services";
import { matchRepository, useRepositories, useWorkingCopySlug } from "@/lib/repos";
import { useTrayLabels } from "@/lib/window";
import { currentWindowRoute, onWindowRouteChange, type WindowRoute } from "@/lib/window-route";
import {
  useNotificationAuthorization,
  useRequestNotificationAuthorization,
} from "@/lib/notifications";

import { ConnectInstance } from "@/surfaces/connect-instance";
import { ReviewWindow } from "@/surfaces/review-window";
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
  CodeQuickOpen,
  CodeTree,
  useCodeSurface,
} from "@/surfaces/code";
import {
  IssuesDetail,
  IssuesInspector,
  IssuesList,
  useIssuesSurface,
} from "@/surfaces/issues";
import {
  PullsDetail,
  PullsInspector,
  PullsList,
  usePullsSurface,
} from "@/surfaces/pulls";
import {
  WorkingCopyDetail,
  WorkingCopyErrorOverlay,
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
import type { PaletteAction, PaletteGroup } from "@/shell/command-palette";
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
  // 托盘在 Go 侧随应用启动就已可用，但那时用的是默认中文文案。
  // 界面语言确定后同步一次，否则英文用户会在托盘里看到中文。
  useTrayLabels();

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
  // 这个窗口要显示什么，完全由它自己的 URL 片段决定。
  //
  // 不能用全局状态：多窗口下全局状态由最后写入者胜出，两个评审窗会显示同一个
  // PR。片段随窗口自己走，各看各的。同窗口内改片段时靠 hashchange 跟进。
  const [route, setRoute] = useState<WindowRoute>(() => currentWindowRoute());

  useEffect(() => onWindowRouteChange(() => setRoute(currentWindowRoute())), []);

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

  // 评审窗在会话就绪后走自己的渲染分支：它没有左轨与列表栏，也不该落进
  // 主界面外壳。放在会话判定之后是有意的——评审窗同样要登录才拉得到 PR，
  // 未登录时它和主窗口一样先给连接页/登录页。
  if (route.kind === "review") {
    return <ReviewWindow prNumber={route.prNumber} repoId={route.repoId} />;
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

  // 系统通知：只在用户显式点开关时才申请授权。启动就弹授权请求时，
  // 用户还不知道会收到什么，拒绝一次之后系统就很难再让他改回来。
  const notifyAuth = useNotificationAuthorization();
  const requestNotifyAuth = useRequestNotificationAuthorization();

  // PR 与 Issue 面需要一个服务端仓库 id。它有两个来源：
  //   1. 当前工作副本的 git remote 能对上哪个仓库（"我就在这个仓库里改代码"）；
  //   2. 对不上时由各面自己退回可见仓库列表的首个，并显示仓库选择器。
  // remote 地址从本机 git 读取（不经网络），解析成 owner/repo 后与仓库列表比对。
  const activeCopyId = wc.active?.id ?? null;
  const remoteSlug = useWorkingCopySlug(activeCopyId);
  const repoList = useRepositories();
  const preferredRepoId = useMemo(() => {
    const { matched } = matchRepository(repoList.data ?? [], remoteSlug.data ?? null);
    return matched?.id ?? null;
  }, [repoList.data, remoteSlug.data]);

  const pulls = usePullsSurface(preferredRepoId);
  const issues = useIssuesSurface(preferredRepoId);

  const conn = online ? "online" : "offline";

  // 标题栏的仓库与分支 chip：原型在这里常驻展示当前上下文，
  // 用户一眼知道"我现在在哪个仓库、哪个分支"。
  // 仓库名取自工作副本路径的最后一段，分支取其实时状态。
  const repoChip = wc.active ? baseNameOf(wc.active.path) : instanceName || t("status.offline");
  const branchChip = wc.status?.branch || "";
  const ahead = wc.status?.ahead ?? 0;
  const behind = wc.status?.behind ?? 0;

  // 命令面板的动作组。
  //
  // 只组装**当下真的能执行**的动作：七个 surface 的跳转，以及工作副本与
  // 当前文件存在时的两个本地动作。协作类动作（加入实时会话、只读观察、
  // 复制行链接）依赖尚未实现的协作能力，不在此列出——留一个点了没反应的
  // 条目比没有这个入口更糟。
  //
  // 前提不满足时整组不出现，而不是渲染成禁用态：命令面板是"我能做什么"的
  // 清单，塞满灰掉的条目会让它变成一份功能目录。
  const paletteGroups = useMemo<PaletteGroup[]>(() => {
    const groups: PaletteGroup[] = [
      {
        key: "goto",
        label: t("palette.groupGoTo"),
        actions: SURFACES.map((s) => ({
          id: `goto-${s.id}`,
          group: "goto",
          label: t(s.i18nKey),
          icon: s.icon,
          hint: `⌘${s.key}`,
          run: () => onSelect(s.id),
        })),
      },
    ];

    const local: PaletteAction[] = [];
    const activeCopy = wc.active;
    if (activeCopy) {
      // 快速打开：跳去 Code 面并让它自己去挑文件。
      // 这里不复制 Code 面的文件搜索状态——那会造出第二份真相。
      local.push({
        id: "local-quick-open",
        group: "local",
        label: t("palette.quickOpen"),
        icon: "search",
        hint: "⌘P",
        run: () => onSelect("code"),
      });
    }
    if (activeCopy && code.activePath) {
      local.push({
        id: "local-open-editor",
        group: "local",
        label: t("palette.openInEditor"),
        icon: "external",
        run: () => {
          void WorkingCopyService.OpenInEditor(activeCopy.id, code.activePath as string);
        },
      });
    }
    if (local.length > 0) {
      groups.push({ key: "local", label: t("palette.groupLocal"), actions: local });
    }

    return groups;
  }, [t, onSelect, wc.active, code.activePath]);

  // 收件箱与工作副本已接真实数据；其余面保持骨架。
  if (surface === "inbox") {
    return (
      <Shell
        active={surface}
        onSelect={onSelect}
        conn={conn}
        offline={!online}
        badges={{ inbox: inbox.unreadCount }}
        notificationsAuthorized={notifyAuth.data === true}
        notificationsPending={requestNotifyAuth.isPending}
        onEnableNotifications={() => requestNotifyAuth.mutate()}
        userName={creds?.username}
        repoChip={repoChip}
        branchChip={branchChip}
        ahead={ahead}
        behind={behind}
        paletteGroups={paletteGroups}
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
        notificationsAuthorized={notifyAuth.data === true}
        notificationsPending={requestNotifyAuth.isPending}
        onEnableNotifications={() => requestNotifyAuth.mutate()}
        userName={creds?.username}
        repoChip={repoChip}
        branchChip={branchChip}
        ahead={ahead}
        behind={behind}
        paletteGroups={paletteGroups}
        list={<WorkingCopyList state={wc} />}
        detail={<WorkingCopyDetail state={wc} />}
        inspector={<WorkingCopyInspector state={wc} />}
        overlay={<WorkingCopyErrorOverlay state={wc} />}
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
        notificationsAuthorized={notifyAuth.data === true}
        notificationsPending={requestNotifyAuth.isPending}
        onEnableNotifications={() => requestNotifyAuth.mutate()}
        userName={creds?.username}
        repoChip={code.active ? baseNameOf(code.active.path) : repoChip}
        branchChip={branchChip}
        ahead={ahead}
        behind={behind}
        paletteGroups={paletteGroups}
        list={<CodeTree state={code} />}
        detail={
          <>
            <CodeDetail state={code} />
            <CodeQuickOpen state={code} />
          </>
        }
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

  if (surface === "pulls") {
    return (
      <Shell
        active={surface}
        onSelect={onSelect}
        conn={conn}
        offline={!online}
        badges={{ inbox: inbox.unreadCount }}
        notificationsAuthorized={notifyAuth.data === true}
        notificationsPending={requestNotifyAuth.isPending}
        onEnableNotifications={() => requestNotifyAuth.mutate()}
        userName={creds?.username}
        repoChip={pulls.repo?.path || repoChip}
        branchChip={branchChip}
        ahead={ahead}
        behind={behind}
        paletteGroups={paletteGroups}
        list={<PullsList state={pulls} />}
        detail={<PullsDetail state={pulls} />}
        inspector={<PullsInspector state={pulls} />}
        statusLeft={
          <>
            <StatusItem icon="pr">{t("nav.pulls")}</StatusItem>
            <span className="text-[var(--color-faint)]">·</span>
            <span>
              {pulls.repo?.path ?? t("pulls.noRepo")}
            </span>
          </>
        }
        statusRight={
          <StatusItem icon="pulse" tone={online ? "sage" : "amber"}>
            {online ? t("status.connected") : t("status.offline")}
          </StatusItem>
        }
      />
    );
  }

  if (surface === "issues") {
    return (
      <Shell
        active={surface}
        onSelect={onSelect}
        conn={conn}
        offline={!online}
        badges={{ inbox: inbox.unreadCount }}
        notificationsAuthorized={notifyAuth.data === true}
        notificationsPending={requestNotifyAuth.isPending}
        onEnableNotifications={() => requestNotifyAuth.mutate()}
        userName={creds?.username}
        repoChip={issues.repo?.path || repoChip}
        branchChip={branchChip}
        ahead={ahead}
        behind={behind}
        paletteGroups={paletteGroups}
        list={<IssuesList state={issues} />}
        detail={<IssuesDetail state={issues} />}
        inspector={<IssuesInspector state={issues} />}
        statusLeft={
          <>
            <StatusItem icon="issue">{t("nav.issues")}</StatusItem>
            <span className="text-[var(--color-faint)]">·</span>
            <span>{issues.repo?.path ?? t("pulls.noRepo")}</span>
          </>
        }
        statusRight={
          <StatusItem icon="pulse" tone={online ? "sage" : "amber"}>
            {online ? t("status.connected") : t("status.offline")}
          </StatusItem>
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
        notificationsAuthorized={notifyAuth.data === true}
        notificationsPending={requestNotifyAuth.isPending}
        onEnableNotifications={() => requestNotifyAuth.mutate()}
        userName={creds?.username}
        repoChip={repoChip}
        branchChip={branchChip}
        ahead={ahead}
        behind={behind}
        paletteGroups={paletteGroups}
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










