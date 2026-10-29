import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { RouterProvider } from "react-router";

import { queryClient } from "@/lib/query-client";
import { router } from "@/lib/router";

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
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
