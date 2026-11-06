import {
  useMutation,
  useQuery,
  type UseMutationOptions,
  type UseQueryOptions,
} from "@tanstack/react-query";

/**
 * 查询封装：统一默认的缓存与重试策略，页面只关心数据本身。
 * 接口路径与返回体由 `api`（openapi-fetch + 生成的 schema）保证类型安全。
 */
export function useApiQuery<TData>(options: UseQueryOptions<TData, Error>) {
  return useQuery<TData, Error>({
    staleTime: 30_000,
    retry: (failureCount, error) => {
      const status = (error as { status?: number } | undefined)?.status;
      if (status && status < 500) return false;
      return failureCount < 1;
    },
    ...options,
  });
}

export function useApiMutation<TData, TVariables>(
  mutationFn: (variables: TVariables) => Promise<TData>,
  options?: Partial<UseMutationOptions<TData, Error, TVariables>>,
) {
  return useMutation<TData, Error, TVariables>({ mutationFn, ...options });
}
