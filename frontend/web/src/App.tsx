import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { Toaster } from "sonner";
import { RouterProvider } from "react-router";

import { queryClient } from "@/lib/query-client";
import { router } from "@/lib/router";

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      {/* 尊重系统「减弱动态效果」：位移与布局动画关闭，淡入淡出保留，
          因此切页仍然连贯，只是不再有上下浮动。 */}
      <MotionConfig reducedMotion="user">
        <RouterProvider router={router} />
      </MotionConfig>
      {/* toast 挂在路由外层，避免页面切换时提示一起卸载 */}
      <Toaster
        position="bottom-right"
        theme="dark"
        toastOptions={{
          classNames: {
            toast: "!border-edge-2 !bg-ink-850 !text-bone-2",
            description: "!text-muted",
          },
        }}
      />
    </QueryClientProvider>
  );
}
