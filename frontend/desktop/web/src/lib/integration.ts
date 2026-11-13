/**
 * 系统集成的数据层：深链协议注册与开机自启。
 *
 * 两件事都写 Windows 的 HKCU（Go 侧 `internal/platform/shellreg`），因此每次
 * 开关之后都要重新读一次现状，而不是在本地翻一个布尔值：写注册表可能失败
 * （策略限制、权限被改），乐观显示会让界面说"已开启"而系统里什么都没有。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { SystemService } from "@/bindings/github.com/kustos/kustos-desktop/internal/services";
import type { SystemIntegration } from "@/bindings/github.com/kustos/kustos-desktop/internal/services/models";

export const integrationKeys = {
  status: ["system-integration"] as const,
};

/** 读取系统集成现状。 */
export function useIntegrationStatus() {
  return useQuery({
    queryKey: integrationKeys.status,
    queryFn: () => SystemService.IntegrationStatus() as Promise<SystemIntegration>,
    // 注册表只在本机被这个开关改写，没有外部变化的合理来源；
    // 但仍要短缓存，避免每次切面都读一次注册表。
    staleTime: 30_000,
    retry: false,
  });
}

/** 开启/关闭开机自启。 */
export function useSetAutostart() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => SystemService.SetAutostart(enabled),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: integrationKeys.status });
    },
  });
}

/** 注册 `kustos://` 深链协议。 */
export function useRegisterProtocol() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => SystemService.RegisterProtocol(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: integrationKeys.status });
    },
  });
}

/** 移除 `kustos://` 深链协议注册。 */
export function useUnregisterProtocol() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => SystemService.UnregisterProtocol(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: integrationKeys.status });
    },
  });
}
