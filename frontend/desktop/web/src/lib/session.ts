import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { SessionService } from "@/bindings/github.com/kustos/kustos-desktop/internal/services";
import type { Credentials, InstanceInfo } from "@/bindings/github.com/kustos/kustos-desktop/internal/services/models";
import type { Instance } from "@/bindings/github.com/kustos/kustos-desktop/internal/store/models";

/**
 * 会话层的 React 封装。
 *
 * 这里刻意**不做乐观更新**：登录与刷新都涉及安全状态，界面必须反映
 * Go 侧的真实结果，而不是"猜它成功了"。失败时用户需要看到确切原因
 * （密码错？实例连不上？钥匙串不可用？）。
 */

export const sessionKeys = {
  instances: ["instances"] as const,
  active: ["active-instance"] as const,
  probe: (baseURL: string) => ["instance-probe", baseURL] as const,
};

/**
 * 探活一个实例。
 *
 * 引导页要用它判断"登录框能不能解锁"与"版本是否过旧"，而实例档案里只存了
 * 名称与版本号，没有契约信息——进度条式的旧数据不能拿来当依据。
 *
 * `Probe` 不抛错而是把失败写成 `reachable: false`，因此这里不需要错误分支。
 */
export function useInstanceProbe(baseURL: string | null) {
  return useQuery({
    queryKey: sessionKeys.probe(baseURL ?? ""),
    queryFn: () => SessionService.Probe(baseURL as string),
    enabled: Boolean(baseURL),
    // 用户可能刚改好网络就重试，别让缓存把结论钉死太久。
    staleTime: 30_000,
    retry: false,
  });
}

/** 已保存的实例列表。 */
export function useInstances() {
  return useQuery({
    queryKey: sessionKeys.instances,
    queryFn: async () => (await SessionService.ListInstances()) ?? [],
    // 实例档案是本机事实，变化只由本应用的写操作引起；
    // 但多窗口下别的窗口可能增删，因此保留一个不长的 staleTime。
    staleTime: 5_000,
  });
}

/** 当前活动实例。 */
export function useActiveInstance() {
  return useQuery({
    queryKey: sessionKeys.active,
    queryFn: async () => {
      const [instance, ok] = await SessionService.ActiveInstance();
      return ok ? instance : null;
    },
    staleTime: 5_000,
  });
}

/** 添加实例（先探活）。 */
export function useAddInstance() {  const qc = useQueryClient();
  return useMutation({
    mutationFn: (baseURL: string) => SessionService.AddInstance(baseURL),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: sessionKeys.instances });
      // 添加即成为活动实例（Go 侧这样约定），因此 active 也必须失效：
      // 只刷 instances 的话，界面查到的 active 仍是旧的 null，
      // 于是刚添加完实例又被弹回连接页。
      void qc.invalidateQueries({ queryKey: sessionKeys.active });
    },
  });
}

/** 删除实例。 */
export function useRemoveInstance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => SessionService.RemoveInstance(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: sessionKeys.instances });
      void qc.invalidateQueries({ queryKey: sessionKeys.active });
    },
  });
}

/** 登录。 */
export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { instanceID: string; username: string; password: string }) =>
      SessionService.Login(vars.instanceID, vars.username, vars.password),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: sessionKeys.active });
    },
  });
}

/** 登出。 */
export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => SessionService.Logout(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: sessionKeys.active });
    },
  });
}

/** 切换活动实例（多实例并存时的切换器）。 */
export function useSetActiveInstance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => SessionService.SetActiveInstance(id),
    onSuccess: () => {
      // 活动实例变了，依赖它的查询全部失效。
      void qc.invalidateQueries({ queryKey: sessionKeys.active });
    },
  });
}

/** 启动时尝试用 Keychain 里的 refresh 恢复会话。 */
export function useRestoreSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (instanceID: string) => SessionService.RestoreSession(instanceID),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: sessionKeys.active });
    },
  });
}

export type { Credentials, InstanceInfo, Instance };
