/**
 * 文档模式机：一个文件同一时刻只有一个真相来源。
 *
 * 桌面端同时存在三份"同一个文件"：磁盘上的工作树、分支上的内容、以及活跃的
 * CRDT 会话。设计上不允许它们同时被写——双写一定漂移：磁盘改动不进 CRDT，
 * 别人看不到；下次 join 时它又会被当成"本地改动"要求处理。这类 bug 只在多人
 * 同时操作时出现，最难查。
 *
 * 因此本模块只做两件事，且都不碰网络与磁盘：
 *
 *  1. 进入协作前的四步预检（顺序不能变，每一步都可能终止）；
 *  2. 模式之间的迁移规则（断线不等于退出协作）。
 *
 * 保持纯函数的理由：这些判断错了会在多人同时编辑时丢数据，必须有单测钉住；
 * 而数据层与界面各自只需要读一个结果对象。
 */

/** 一个文件此刻的真相来源。 */
export type DocMode = "disk" | "live" | "observe";

/**
 * 预检的四个步骤。
 *
 * 顺序即执行顺序：先确认在和正确的分支说话，再看本地有没有会丢的东西，
 * 然后看线上有没有别人的保存，最后才判断能不能开新会话。
 */
export type PrecheckStep = "branch" | "local" | "draft" | "peers";

/** 用户在阻塞项上可以做的处置。 */
export type PrecheckResolution =
  | "checkout"
  | "commit"
  | "stash"
  | "discard"
  | "save"
  | "observe"
  /**
   * 以本地内容开新会话（`seed`）。
   *
   * 这是一次**显式覆盖**：网关的初始内容来自服务端分支，本地没提交的内容
   * 它看不见。只允许在"没人在线"时用它——有人在线还拿本地内容开新文档，
   * 等于把别人的内容顶掉。
   */
  | "seed";

/** 一条预检发现。 */
export interface PrecheckIssue {
  step: PrecheckStep;
  /**
   * 供界面选文案键的稳定标识。
   *
   * 这里不带句子：数据层没有 i18n 上下文，写死中文会让英文界面里冒出中文。
   */
  code: "branch-mismatch" | "local-changes" | "unsaved-buffer" | "draft-ahead" | "peers-unknown";
  /** 可选的处置；空数组表示这条只是提示，不阻塞进入。 */
  resolutions: PrecheckResolution[];
  /** 阻塞进入协作。提示类发现为 false。 */
  blocking: boolean;
  /** 与发现相关的数量（草稿领先的提交数、在线人数），无则为 0。 */
  count: number;
}

/** 预检结论。 */
export interface PrecheckResult {
  /**
   * 通过后应当以哪种方式建立会话。
   *
   * - `join`：接入已有的 CRDT 文档，别人的内容先到；
   * - `seed`：没有人在线，用分支上的内容开新会话；
   * - `observe`：用户选择只看别人改；
   * - `blocked`：还有阻塞项没处理完。
   */
  action: "join" | "seed" | "observe" | "blocked";
  issues: PrecheckIssue[];
}

/** 预检的输入，全部由调用方查好（本模块不发请求、不读磁盘）。 */
export interface PrecheckInput {
  /** 工作副本当前检出的分支。 */
  localBranch: string;
  /** 会话要绑定的分支（docKey 的中段）。 */
  docBranch: string;
  /** 该文件相对 HEAD 有未提交改动（含未跟踪）。 */
  changed: boolean;
  /**
   * 该文件在编辑器里还有没写盘的改动。
   *
   * 与 `changed` 分开：缓冲区里的内容 git 还看不见，提交也带不走它。
   * 直接进协作会把它顶掉——屏幕上的字消失，磁盘和分支里都没有。
   */
  unsaved?: boolean;
  /** 本地草稿分支领先本地分支的提交数；0 表示没有待发布的在线保存。 */
  draftAhead: number;
  /** 该文档当前的活跃连接数（不含自己）。 */
  peers: number;
  /**
   * 在线人数是否可信。
   *
   * `collab/active` 在协作感知不可用时返回空清单并标记降级。空清单既可能是
   * "确实没人在编辑"，也可能是"感知能力不可用"；把后者当成前者，用户会以为
   * 可以安全地以本地内容开新会话——这是预检里最危险的误判。
   */
  peersKnown: boolean;
}

/**
 * 这一步能不能用「以本地为准」开新会话。
 *
 * 条件是"确实没人在线"：感知不可用时按有人在线处理（`peersKnown === false`），
 * 因为拿本地内容开新文档会把别人的内容顶掉，而猜错的代价不对称——join 猜错
 * 只是白等一次同步，seed 猜错是丢数据。
 */
function canSeedFromLocal(input: PrecheckInput): boolean {
  return input.peersKnown && input.peers === 0;
}

/**
 * 执行四步预检。
 *
 * Args:
 *
 *	input: 调用方查好的本地与线上状态
 *
 * Returns:
 *
 *	预检结论；`issues` 按步骤顺序排列，界面据此逐条显示处置入口。
 *
 * 只有前两步（分支对齐、本地改动）会阻塞：它们决定"本地有没有会丢的东西"。
 * 草稿领先只是提示（线上保存已经落在草稿分支上，丢不了），在线人数未知则
 * 只封住 `seed`——`join` 由服务端裁决权限与初始内容，仍然安全。
 */
export function precheck(input: PrecheckInput): PrecheckResult {
  const issues: PrecheckIssue[] = [];
  const seedable = canSeedFromLocal(input);

  // 1. 分支对齐：docKey 里带分支，绑错分支等于在另一个世界编辑。
  if (input.localBranch !== input.docBranch) {
    issues.push({
      step: "branch",
      code: "branch-mismatch",
      resolutions: ["checkout", "observe"],
      blocking: true,
      count: 0,
    });
  }

  // 2. 本地改动：磁盘上的内容进不了 CRDT，直接 join 会被人当成本地改动要求
  //    处理，而用户以为自己的改动已经进文档了。
  //
  //    没人在线时多给一条「以本地为准」：那正是这些改动该有的去处——把它们
  //    作为会话的首帧写进文档，再存成草稿分支的提交。它不解除阻塞，因为
  //    "要不要拿本地内容覆盖文档"必须由用户点一下。
  if (input.changed) {
    issues.push({
      step: "local",
      code: "local-changes",
      resolutions: seedable ? ["commit", "stash", "discard", "seed"] : ["commit", "stash", "discard"],
      blocking: true,
      count: 0,
    });
  }

  // 2b. 还没写盘的缓冲区：提交也带不走它，所以只能先保存（或放弃进入）。
  //     没人在线时同样可以「以本地为准」——缓冲区的内容就是最"本地"的那一份。
  if (input.unsaved === true) {
    issues.push({
      step: "local",
      code: "unsaved-buffer",
      resolutions: seedable ? ["save", "observe", "seed"] : ["save", "observe"],
      blocking: true,
      count: 0,
    });
  }

  // 3. 在线草稿：只是提示——那些保存已经落在草稿分支上，不会丢。
  if (input.draftAhead > 0) {
    issues.push({
      step: "draft",
      code: "draft-ahead",
      resolutions: [],
      blocking: false,
      count: input.draftAhead,
    });
  }

  // 4. 在线人数：未知时只封 seed。
  const peersUnknown = !input.peersKnown;
  if (peersUnknown) {
    issues.push({
      step: "peers",
      code: "peers-unknown",
      resolutions: [],
      blocking: false,
      count: 0,
    });
  }

  if (issues.some((issue) => issue.blocking)) {
    return { action: "blocked", issues };
  }

  // 有人在线必须 join（本地内容会覆盖别人的文档）；没人在线才能 seed。
  // 感知不可用时按"有人在线"处理：seed 会把本地内容写进新文档，猜错的代价
  // 是别人的内容被顶掉，而 join 猜错只是白等一次同步。
  const action: PrecheckResult["action"] = seedable ? "seed" : "join";

  return { action, issues };
}

/** 能让模式机走一步的事件。 */
export type DocEvent = "enter" | "leave" | "kick" | "disconnect" | "reconnect";

/**
 * 计算模式迁移后的新状态。
 *
 * Args:
 *
 *	current: 当前模式
 *	event:   发生的事件
 *
 * Returns:
 *
 *	迁移后的模式；无法处理的事件组合返回 `current`（不抛异常——传输层的
 *	乱序事件不该让编辑器崩掉）。
 *
 * 关键一行是 `disconnect`：断线**不改变模式**。Y.Doc 离线仍可编辑，重连自动
 * 合并，这是 CRDT 白送的能力；把断线当成退出协作会让用户以为自己的改动丢了。
 * 界面要表达的是第三态"离线协作缓冲 N 条变更"，而不是开关。
 */
export function transition(current: DocMode, event: DocEvent): DocMode {
  switch (event) {
    case "enter":
      return current === "disk" ? "live" : current;
    case "leave":
      return current === "live" ? "disk" : current;
    case "kick":
      // 权限被降级或被请出会话：仍能看，不能再写。
      return current === "live" ? "observe" : current;
    case "disconnect":
    case "reconnect":
      // 模式不变：离线仍是 live（可编辑、可合并），重连也只是恢复传输。
      return current;
    default:
      return current;
  }
}

/**
 * 某个模式下 `⌘S` 是什么意思。
 *
 * 语义随模式改变是本设计最容易误解的地方（用户以为已经提交到分支），因此
 * 界面必须显式说明：磁盘模式写盘，协作模式落草稿分支，观察模式不可写。
 */
export function saveSemantics(mode: DocMode): "disk" | "draft" | "none" {
  switch (mode) {
    case "disk":
      return "disk";
    case "live":
      return "draft";
    case "observe":
      return "none";
    default:
      return "none";
  }
}

/** 该模式下编辑器是否可写。 */
export function isWritable(mode: DocMode): boolean {
  return mode === "live" || mode === "disk";
}
