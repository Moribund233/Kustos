import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "night" | "light";

interface UiState {
  theme: Theme;
  sidebarCollapsed: boolean;
  setTheme: (theme: Theme) => void;
  toggleSidebar: () => void;
}

/** 纯客户端偏好：主题、侧栏折叠等。服务端数据一律走 React Query。 */
export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: "night",
      sidebarCollapsed: false,
      setTheme: (theme) => set({ theme }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
    }),
    { name: "kustos.ui" },
  ),
);
