import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "night" | "light";

/** 面包屑条目；`to` 缺省时渲染为纯文本。 */
export interface Crumb {
  label: string;
  to?: string;
}

interface UiState {
  theme: Theme;
  sidebarCollapsed: boolean;
  /** 命令面板开关：顶栏搜索按钮与快捷键共用一个状态源。 */
  paletteOpen: boolean;
  /** 当前面包屑；页面挂载时写入，顶栏读取。 */
  crumbs: Crumb[];
  setTheme: (theme: Theme) => void;
  toggleSidebar: () => void;
  setPaletteOpen: (open: boolean) => void;
  /** 快捷键用的开关切换。 */
  togglePalette: () => void;
  setCrumbs: (crumbs: Crumb[]) => void;
}

/** 纯客户端偏好：主题、侧栏折叠、面板开关。服务端数据一律走 React Query。 */
export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: "night",
      sidebarCollapsed: false,
      paletteOpen: false,
      crumbs: [],
      setTheme: (theme) => set({ theme }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      togglePalette: () => set((state) => ({ paletteOpen: !state.paletteOpen })),
      setCrumbs: (crumbs) => set({ crumbs }),
    }),
    { name: "kustos.ui" },
  ),
);
