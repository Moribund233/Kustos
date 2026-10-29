import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 服务端状态变化没那么频繁；30s 内不重复打接口。
      staleTime: 30_000,
      // 4xx 不重试，只对网络抖动与 5xx 重试一次。
      retry: (failureCount, error) => {
        const status = (error as { status?: number } | undefined)?.status;
        if (status && status < 500) return false;
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
    },
  },
});
