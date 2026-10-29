import { Bot, Code2, GitPullRequest, Home, MessageSquare, Settings, Shield } from "lucide-react";

export interface NavItem {
  id: string;
  /** i18n 键；侧栏文案随语言切换。 */
  labelKey: string;
  icon: typeof Home;
  /** 路由路径。 */
  to: string;
  badge?: string;
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

/**
 * 侧栏分区。
 *
 * 与后端领域一一对应：工作台分区内是仓库级功能，实例分区只放管理员面。
 * `admin` 条目是否可见取决于当前用户的 `is_admin`，由调用方过滤后再传入。
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    label: "Workspace",
    items: [
      { id: "overview", labelKey: "nav.watch", icon: Home, to: "/" },
      { id: "code", labelKey: "nav.code", icon: Code2, to: "/code" },
      {
        id: "pull",
        labelKey: "nav.pullRequests",
        icon: GitPullRequest,
        to: "/pull-requests",
      },
      { id: "issues", labelKey: "nav.issues", icon: MessageSquare, to: "/issues" },
      { id: "agent", labelKey: "nav.agent", icon: Bot, to: "/agent" },
      { id: "chat", labelKey: "nav.chat", icon: MessageSquare, to: "/chat" },
    ],
  },
  {
    label: "Instance",
    items: [{ id: "admin", labelKey: "nav.adminConsole", icon: Shield, to: "/admin" }],
  },
];

/** 侧栏底部的实例标记图标。 */
export const INSTANCE_ICON = Settings;
