import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ClonePanel } from "@/surfaces/clone-panel";
import { ConnectForm } from "@/surfaces/connect-instance";
import { LoginForm } from "@/surfaces/login";
import { Icon } from "@/shell/icon";
import { WindowFrame } from "@/shell/window-frame";
import {
  instanceTooOld,
  onboardingState,
  stepState,
  type StepState,
} from "@/lib/onboarding";
import {
  useActiveInstance,
  useInstanceProbe,
  useInstances,
  useSetActiveInstance,
  type Credentials,
} from "@/lib/session";
import { useWorkingCopies } from "@/lib/working-copy";

/**
 * 首次启动的引导：连接实例 → 登录 → 克隆仓库。
 *
 * 一页三段而不是三个页面：这三步有严格的前后依赖，拆成路由后用户会在
 * "下一步"和浏览器式的前进后退之间来回猜。走完的那一步折叠成一行可点开的
 * 摘要，当前这一步展开——想改实例地址就直接点第一步，不必重走流程。
 *
 * 判定全在 `lib/onboarding.ts`（纯函数，可脱机测试），这里只负责画。
 */
export function Onboarding({
  creds,
  onLoggedIn,
  onComplete,
}: {
  /** 已经恢复的会话；为空表示还没登录。 */
  creds: Credentials | null;
  onLoggedIn: (creds: Credentials) => void;
  /** 三步都走完（含跳过克隆），可以进主界面。 */
  onComplete: () => void;
}) {
  const { t } = useTranslation();

  const instances = useInstances();
  const active = useActiveInstance();
  const setActive = useSetActiveInstance();
  const copies = useWorkingCopies();

  // 已有实例档案时第一步先给列表，点"连接其他实例"才回到输入表单。
  const [showForm, setShowForm] = useState(false);
  const [logged, setLogged] = useState<Credentials | null>(creds);
  const [skipped, setSkipped] = useState(false);

  const instance = active.data ?? null;
  const probe = useInstanceProbe(instance?.baseUrl ?? null);
  const reachable = probe.data?.reachable ?? false;
  const tooOld = probe.data ? instanceTooOld(probe.data) : false;

  const hasWorkingCopy = (copies.data ?? []).length > 0;
  const state = onboardingState({
    reachable,
    tooOld,
    loggedIn: logged != null,
    hasWorkingCopy,
    cloneSkipped: skipped,
  });

  // 完成时交给外层。放 effect 里而不是渲染中回调：渲染期间更新父组件状态
  // 会被 React 判为副作用。
  useEffect(() => {
    if (state.ready) onComplete();
  }, [state.ready, onComplete]);

  const saved = instances.data ?? [];

  return (
    <WindowFrame>
      <div className="flex min-h-0 flex-1 justify-center overflow-y-auto px-8 py-10">
        <div className="w-full max-w-[520px]">
          <h1 className="font-display mb-1 text-lg text-bone">{t("onboarding.title")}</h1>
          <p className="mb-7 text-[12px] leading-relaxed text-muted">{t("onboarding.hint")}</p>

          {/* 第一步：连接实例 */}
          <Step
            index={1}
            label={t("onboarding.stepConnect")}
            view={stepState(state, "connect")}
            summary={instance ? instance.name || instance.baseUrl : null}
            onReopen={() => setShowForm(true)}
          >
            {saved.length > 0 && !showForm ? (
              <div className="flex flex-col gap-1">
                {saved.map((it) => (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => {
                      if (it.id !== instance?.id) setActive.mutate(it.id);
                    }}
                    className={[
                      "flex items-center gap-2 rounded-md border px-3 py-2 text-left text-[12px]",
                      it.id === instance?.id
                        ? "border-[rgba(242,174,91,0.45)] bg-[rgba(242,174,91,0.08)] text-bone"
                        : "border-[var(--color-edge-2)] text-muted hover:border-[var(--color-edge-3)] hover:text-bone-2",
                    ].join(" ")}
                  >
                    <Icon name="server" size={13} />
                    <span className="truncate">{it.name || it.baseUrl}</span>
                    <span className="ml-auto shrink-0 font-mono text-[10.5px] text-faint">
                      {it.baseUrl.replace(/^https?:\/\//, "")}
                    </span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setShowForm(true)}
                  className="mt-1 self-start text-[11px] text-faint underline-offset-2 hover:text-bone hover:underline"
                >
                  {t("onboarding.useOther")}
                </button>
              </div>
            ) : (
              <ConnectForm onPicked={() => setShowForm(false)} />
            )}
          </Step>

          {/* 第二步：登录。实例没确认可用前整个表单置灰。 */}
          <Step
            index={2}
            label={t("onboarding.stepLogin")}
            view={stepState(state, "login")}
            summary={logged ? logged.username : null}
          >
            {state.step === "login" && instance ? (
              <>
                {!state.loginEnabled && (
                  <p className="mb-3 text-[11px] leading-relaxed text-faint">
                    {probe.isLoading ? t("session.connecting") : t("onboarding.loginLockedHint")}
                  </p>
                )}
                <LoginForm
                  instance={instance}
                  disabled={!state.loginEnabled}
                  onSuccess={(c) => {
                    setLogged(c);
                    onLoggedIn(c);
                  }}
                />
              </>
            ) : null}
          </Step>

          {/* 第三步：克隆 */}
          <Step
            index={3}
            label={t("onboarding.stepClone")}
            view={stepState(state, "clone")}
            summary={hasWorkingCopy ? t("onboarding.done") : null}
          >
            {state.step === "clone" ? (
              <ClonePanel
                canSkip={state.canSkipClone}
                onSkip={() => setSkipped(true)}
                onDone={() => setSkipped(true)}
              />
            ) : null}
          </Step>
        </div>
      </div>
    </WindowFrame>
  );
}

/** 一步的外壳：完成的折叠成一行摘要，当前的展开。 */
function Step({
  index,
  label,
  view,
  summary,
  onReopen,
  children,
}: {
  index: number;
  label: string;
  view: StepState;
  summary: string | null;
  onReopen?: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  // 重开只是把内容再渲染出来；不带 onReopen 的步骤（登录、克隆）完成后
  // 没有"改"的入口——重登或重拉都该走各自的界面，不该从引导页回退。
  const reopened = open && onReopen != null;

  if (view === "locked") {
    return (
      <div className="mb-3 flex items-center gap-2.5 rounded-md border border-[var(--color-edge-1)] px-3 py-2 opacity-50">
        <Dot view="locked" index={index} />
        <span className="text-[12px] text-faint">{label}</span>
        <span className="ml-auto text-[10.5px] text-faint">{t("onboarding.stepLocked")}</span>
      </div>
    );
  }

  if (view === "done" && !reopened) {
    return (
      <div className="mb-3 flex items-center gap-2.5 rounded-md border border-[var(--color-edge-1)] px-3 py-2">
        <Dot view="done" index={index} />
        <span className="shrink-0 text-[12px] text-muted">{label}</span>
        {summary && <span className="truncate text-[11px] text-faint">{summary}</span>}
        {onReopen && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="ml-auto shrink-0 text-[11px] text-faint underline-offset-2 hover:text-bone hover:underline"
          >
            {t("onboarding.change")}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mb-3 rounded-md border border-[var(--color-edge-2)] px-3 py-2.5">
      <div className="mb-2.5 flex items-center gap-2.5">
        <Dot view={view} index={index} />
        <span className="text-[12px] text-bone">{label}</span>
      </div>
      {children}
    </div>
  );
}

/** 步骤序号圆点：完成后变成对勾。 */
function Dot({ view, index }: { view: StepState; index: number }) {
  if (view === "done") {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-[var(--color-amber)] text-[10px] text-[var(--color-ink-1000)]">
        ✓
      </span>
    );
  }
  return (
    <span className="flex size-4 shrink-0 items-center justify-center rounded-full border border-[var(--color-edge-2)] text-[10px] text-faint">
      {index}
    </span>
  );
}
