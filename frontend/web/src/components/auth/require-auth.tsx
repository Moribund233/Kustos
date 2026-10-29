import { useEffect, type ReactNode } from "react";
import { Navigate } from "react-router";

import { PageFallback } from "@/components/layout/page-fallback";
import { useAuthStore } from "@/stores/auth-store";
import { useRepoStore } from "@/stores/repo-store";

/**
 * 登录态守卫：包在需要会话的路由树外。
 *
 * boot 阶段渲染骨架等恢复结果；anon 踢回登录页；authed 放行并在首次
 * 进入时拉取仓库列表（侧栏与仓库级页面的数据源）。
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const status = useAuthStore((state) => state.status);
  const restore = useAuthStore((state) => state.restore);
  const loadRepos = useRepoStore((state) => state.load);

  useEffect(() => {
    if (status === "boot") void restore();
  }, [status, restore]);

  useEffect(() => {
    if (status === "authed") void loadRepos();
  }, [status, loadRepos]);

  if (status === "boot") return <PageFallback />;
  if (status === "anon") return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/**
 * 游客守卫：已登录时登录页没有存在意义，直接回工作台。
 */
export function AnonOnly({ children }: { children: ReactNode }) {
  const status = useAuthStore((state) => state.status);
  const restore = useAuthStore((state) => state.restore);

  useEffect(() => {
    if (status === "boot") void restore();
  }, [status, restore]);

  if (status === "authed") return <Navigate to="/" replace />;
  return <>{children}</>;
}
