import { Bot, Code2, GitPullRequest, Home, MessageSquare, Shield } from "lucide-react";

export interface NavItem {
  id: string;
  /** i18n 键；侧栏文案随语言切换。 */
  labelKey: string;
  icon: typeof Home;
  /** 路由路径。 */
  to: string;
  /** 右侧计数徽标。 */
  badge?: string;
  /** 徽标用琥珀色：等待本人处理的事项。 */
  badgeAmber?: boolean;
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

/**
 * 侧栏导航分区。
 *
 * 与原型一致分三层：个人面（值守 / Agent）、仓库面（代码 / PR / Issue / 聊天）、
 * 实例面（管理控制台）。`admin` 条目是否可见取决于当前用户的 `is_admin`，
 * 由调用方过滤后再传入。
 */
/**
 * 导航分区。
 *
 * `badge` 留给运行时数据填充（待处理 Agent 运行、未读消息等）；在此之前
 * 一律留空——侧栏不展示写死的假计数。
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    label: "Personal",
    items: [
      { id: "overview", labelKey: "nav.watch", icon: Home, to: "/" },
      { id: "agent", labelKey: "nav.agent", icon: Bot, to: "/agent" },
    ],
  },
  {
    label: "Repository",
    items: [
      { id: "code", labelKey: "nav.code", icon: Code2, to: "/code" },
      { id: "pull", labelKey: "nav.pullRequests", icon: GitPullRequest, to: "/pull-requests" },
      { id: "issues", labelKey: "nav.issues", icon: MessageSquare, to: "/issues" },
      { id: "chat", labelKey: "nav.chat", icon: MessageSquare, to: "/chat" },
    ],
  },
];

/** 实例面独立于仓库面：一个是「你所在的服务器」，一个是「你正在做的事」。 */
export const INSTANCE_SECTION: NavSection = {
  label: "Instance",
  items: [{ id: "admin", labelKey: "nav.adminConsole", icon: Shield, to: "/admin", badge: "admin" }],
};
