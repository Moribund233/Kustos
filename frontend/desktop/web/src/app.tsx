import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";

import { configureAuth, setAccessToken } from "@kustos/api";
import { WorkingCopyService } from "@/bindings/github.com/kustos/kustos-desktop/internal/services";
import { matchRepository, useRepositories, useWorkingCopySlug } from "@/lib/repos";
import { useTrayLabels } from "@/lib/window";
import { currentWindowRoute, onWindowRouteChange, type WindowRoute } from "@/lib/window-route";
import { useDeeplinkNavigation } from "@/lib/deeplink";
import { useNotificationActions } from "@/lib/notifications";
import { useReviewNotifications } from "@/lib/review-notifications";
import { useOfflineCacheWriter } from "@/lib/offline-cache";
import { prReviewKeys, submitPrReview } from "@/lib/pr-reviewers";
import { pullsKeys } from "@/lib/pulls";
import {
  useNotificationAuthorization,
  useRequestNotificationAuthorization,
} from "@/lib/notifications";

import { Onboarding } from "@/surfaces/onboarding";
import { ReviewWindow } from "@/surfaces/review-window";
import { SettingsDetail } from "@/surfaces/settings";
import {
  InboxDetail,
  InboxInspector,
  InboxList,
  useInbox,
} from "@/surfaces/inbox";
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
import { FramedNote } from "@/shell/window-frame";
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

type Phase = "loading" | "onboarding" | "ready";

function Root() {
  const { t } = useTranslation();
  const [surface, setSurface] = useState<Surface>("inbox");
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  // 这个窗口要显示什么，完全由它自己的 URL 片段决定。
  //
  // 不能用全局状态：多窗口下全局状态由最后写入者胜出，两个评审窗会显示同一个
  // PR。片段随窗口自己走，各看各的。同窗口内改片段时靠 hashchange 跟进。
  const [route, setRoute] = useState<WindowRoute>(() => currentWindowRoute());

  useEffect(() => onWindowRouteChange(() => setRoute(currentWindowRoute())), []);

  const instances = useInstances();
  const restore = useRestoreSession();

  const instance = useActiveInstance().data ?? null;

  // 启动时尝试恢复会话。
  useEffect(() => {
    if (phase !== "loading") return;
    if (instances.isLoading) return;

    const list = instances.data ?? [];
    if (list.length === 0) {
      setPhase("onboarding");
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
      // 恢复不出会话不是错误：refresh 过期或被吊销是常态，
      // 直接进引导页让用户登录（实例已选好，展开的就是登录那一步）。
      if (!cancelled) setPhase("onboarding");
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instances.isLoading, instances.data, phase]);

  const handleLoggedIn = useCallback((c: Credentials) => {
    // access token 进 JS 内存（与 Web 同级风险），refresh 已在 Go 的 Keychain 里。
    setAccessToken(c.accessToken);
    setCreds(c);
  }, []);

  const handleOnboardingDone = useCallback(() => setPhase("ready"), []);

  useSurfaceShortcuts(setSurface, phase === "ready");

  // 深链：系统别处发来的 kustos:// 链接要落到对应分区。会话就绪后才订阅，
  // 否则未登录时切分区没有任何意义。
  useDeeplinkNavigation(setSurface, phase === "ready");

  if (phase === "loading") {
    return <FramedNote>{t("session.restoring")}</FramedNote>;
  }

  if (phase === "onboarding") {
    return (
      <Onboarding
        creds={creds}
        onLoggedIn={handleLoggedIn}
        onComplete={handleOnboardingDone}
      />
    );
  }

  // 评审窗在会话就绪后走自己的渲染分支：它没有左轨与列表栏，也不该落进
  // 主界面外壳。放在引导页判定之后是有意的——评审窗同样要登录才拉得到 PR，
  // 未登录时它和主窗口一样先走引导。
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
  // 用户名只用于协作感知层的光标标签：网关会用令牌里的身份再盖一次章。
  const code = useCodeSurface(creds?.username ?? "");

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

  // 离线缓存：查询成功时把只读数据记一份，断网重开时先拿它顶上。
  // 传 true 即可：MainShell 只在会话就绪后才渲染。
  useOfflineCacheWriter(true);

  // 待我评审的 PR 推成系统通知，并带上批准按钮。只在已授权时挂：
  // 没有权限还去发只会得到一串静默失败。
  useReviewNotifications(inbox.items, notifyAuth.data === true);

  // 通知里的动作按钮：用户点了"批准"之后真正提交评审。
  //
  // 桌面端不在通知里直接改状态——通知只是"用户表达了意图"，而批准是一次写请求，
  // 仍要经服务端裁决（自己的 PR 会被 pr_self_approve_forbidden 拒绝）。
  const qc = useQueryClient();
  useNotificationActions((event) => {
    if (event.actionId !== "approve") return;
    const repoId = event.data.repoId ?? "";
    const number = Number(event.data.number ?? "");
    if (repoId === "" || !Number.isInteger(number) || number <= 0) {
      // 缺标识时什么都不做：猜一个 PR 去批准，比不动作危险得多。
      return;
    }
    void (async () => {
      await submitPrReview(repoId, number, { status: "approved" });
      // 与评审窗同一条路径：批准之后详情与评审人都要重取，否则界面停在旧计数上。
      void qc.invalidateQueries({ queryKey: pullsKeys.detail(repoId, number) });
      void qc.invalidateQueries({ queryKey: prReviewKeys.reviewers(repoId, number) });
      void qc.invalidateQueries({ queryKey: ["pulls", repoId] });
    })().catch(() => {
      // 批准失败（自己的 PR、权限不足、网络）不该炸到界面：用户是从通知进来的，
      // 该看到的是评审窗里的真实状态，而不是一条无从处置的弹窗。
    });
  }, true);

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
  // 当前文件存在时的几个本地动作。复制行链接依赖服务端链接接口，不在此列出
  // ——留一个点了没反应的条目比没有这个入口更糟。
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
    // 协作只有两种动作值得进面板：进入（要过预检）与退出。
    // "保存草稿"不在此列——它属于 ⌘S，面板里再放一份只会让人以为有两条路。
    if (activeCopy && code.activePath && code.collabReady && code.mode === "disk") {
      local.push({
        id: "local-collab-enter",
        group: "local",
        label: t("palette.startCollab"),
        icon: "users",
        run: () => {
          onSelect("code");
          code.beginCollab();
        },
      });
    }
    if (code.mode !== "disk") {
      // 发布是独立于退出的动作：退出只是不写了，发布才让内容进正式历史。
      // 只有草稿上真有东西时才进面板——空发布是一次什么都不发生的往返。
      if (code.draftAhead > 0) {
        local.push({
          id: "local-collab-publish",
          group: "local",
          label: t("palette.publishCollab"),
          icon: "git-commit",
          run: () => {
            onSelect("code");
            code.openPublish();
          },
        });
      }
      local.push({
        id: "local-collab-leave",
        group: "local",
        label: t("palette.leaveCollab"),
        icon: "users",
        run: () => code.leaveCollab(),
      });
    }
    if (local.length > 0) {
      groups.push({ key: "local", label: t("palette.groupLocal"), actions: local });
    }

    return groups;
  }, [
    t,
    onSelect,
    wc.active,
    code.activePath,
    code.collabReady,
    code.mode,
    code.draftAhead,
    code.beginCollab,
    code.leaveCollab,
    code.openPublish,
  ]);

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
            {/* 克隆完落在这里：状态条必须说出"哪个仓库"，否则刚拉下来的东西
                看起来像没成功——同一句"未选择工作副本"在克隆前后都成立。 */}
            <StatusItem icon="git-commit">
              {wc.active ? baseNameOf(wc.active.path) : t("status.noWorkingCopy")}
            </StatusItem>
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

  // 设置面：本机系统集成（深链协议、开机自启）。没有列表栏内容——
  // 这些开关不分条目，硬塞一个清单只会让人以为还有别的东西可选。
  if (surface === "settings") {
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
              <h1 className="text-[13px] font-medium text-[var(--color-bone)]">{t("nav.settings")}</h1>
            </div>
            <p className="px-3 py-3 text-[11.5px] leading-relaxed text-[var(--color-muted)]">
              {t("settings.hint")}
            </p>
          </div>
        }
        detail={<SettingsDetail />}
        statusLeft={<StatusItem icon="settings">{t("nav.settings")}</StatusItem>}
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










