/**
 * 首次启动的引导流程。
 *
 * 三步：连接实例 → 登录 → 克隆仓库。它不是三个页面，而是一页上的三段：
 * 走完的步骤折叠成一行摘要，当前这一步展开。理由是这三件事有严格的前后
 * 依赖（没连上实例就没有账号可登，没登录就列不出能克隆的仓库），拆成路由
 * 只会让用户在"下一步"按钮和浏览器式的前进后退之间来回猜。
 *
 * 这里只放判定，不放界面：把"什么时候解锁下一步"写成纯函数，测试才能
 * 脱离 WebView 跑，界面改动也不会悄悄改掉流程。
 */

/** 引导的三步。 */
export type OnboardingStep = "connect" | "login" | "clone";

/** 某一步在界面上的呈现状态。 */
export type StepState = "done" | "active" | "locked";

/** 判定所需的全部事实。 */
export interface OnboardingInput {
  /** 实例探活通过（`InstanceInfo.reachable`）。 */
  reachable: boolean;
  /** 实例版本过旧：契约不兼容，属于阻断态。 */
  tooOld: boolean;
  /** 已经登录（拿到了 access token）。 */
  loggedIn: boolean;
  /** 已经有工作副本。 */
  hasWorkingCopy: boolean;
  /** 用户显式跳过了克隆。 */
  cloneSkipped: boolean;
}

/** 判定结果。 */
export interface OnboardingState {
  /** 当前展开的步骤。 */
  step: OnboardingStep;
  /** 三步都走完（含跳过克隆），可以进主界面。 */
  ready: boolean;
  /** 登录表单是否可用：实例没确认可用前一律置灰。 */
  loginEnabled: boolean;
  /** 克隆这一步能否跳过。 */
  canSkipClone: boolean;
}

/**
 * 算出当前该停在哪一步。
 *
 * 版本过旧与连不上都算"实例没准备好"：前者是明确的不兼容，后者是暂时不通。
 * 两种情况都停在第一步，因为此时登录必然失败，让用户先填密码再看到
 * "登录失败"是把一个已经知道的原因藏起来。
 */
export function onboardingState(input: OnboardingInput): OnboardingState {
  const loginEnabled = input.reachable && !input.tooOld;

  if (!loginEnabled) {
    return { step: "connect", ready: false, loginEnabled: false, canSkipClone: false };
  }
  if (!input.loggedIn) {
    return { step: "login", ready: false, loginEnabled: true, canSkipClone: false };
  }
  // 登录后默认落点是克隆：直接从仓库列表挑一个是最短路径。
  // 但可以跳过——只想翻 Inbox 的人不该被迫先下载一个仓库。
  const cloneDone = input.hasWorkingCopy || input.cloneSkipped;
  return { step: "clone", ready: cloneDone, loginEnabled: true, canSkipClone: true };
}

/**
 * 实例是否过旧。
 *
 * 判据只有一条：实例公布了契约版本，而它声明的最低兼容版本不是本客户端实现的
 * `v1`。没有契约（老实例）不算过旧——那时没有任何依据判定不兼容，按应用版本
 * 探活的结果放行即可。
 *
 * 抽成函数是因为它有两个使用点（探活结果的红字提示、引导流程的解锁判定），
 * 两处各写一遍迟早会漂移。
 */
export function instanceTooOld(info: {
  apiCompat?: { apiMin?: string } | null;
}): boolean {
  const min = info.apiCompat?.apiMin;
  return Boolean(min) && min !== "v1";
}

/** 某一步该显示成什么样。 */
export function stepState(state: OnboardingState, step: OnboardingStep): StepState {
  const order: OnboardingStep[] = ["connect", "login", "clone"];
  const current = order.indexOf(state.step);
  const self = order.indexOf(step);

  if (state.ready) return "done";
  if (self < current) return "done";
  if (self === current) return "active";
  return "locked";
}
