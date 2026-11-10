import { useMutation, useQuery } from "@tanstack/react-query";

import { NotificationService } from "@/bindings/github.com/kustos/kustos-desktop/internal/services";

/**
 * 系统通知的数据层。
 *
 * 这里只做两件事：把 Go 侧的通知服务包成查询/变更，以及在权限未知时先问一次。
 * **不判断"哪些事件值得通知"**——那取决于服务端给出的事实（PR 是否仍待审、
 * Issue 是否指派给我），在界面里猜一套判定等于埋一条与服务端漂移的逻辑。
 * 界面只在已经知道某件事需要用户注意时调用 `useNotify`。
 */

export const notificationKeys = {
  authorization: ["notifications", "authorization"] as const,
};

/**
 * 查询系统通知权限。
 *
 * 未授权不算错误：用户可能拒绝了通知，界面据此不再提示，而不是反复弹窗。
 */
export function useNotificationAuthorization() {
  return useQuery({
    queryKey: notificationKeys.authorization,
    queryFn: () => NotificationService.CheckAuthorization(),
    // 权限是系统设置，运行期不会自己变；只在窗口重建时重新查一次。
    staleTime: Infinity,
    retry: false,
  });
}

/** 一条要发出的通知。 */
export interface NotifyArgs {
  /** 通知标识；同一 ID 的新通知替换旧的。 */
  id: string;
  title: string;
  body?: string;
  /** 相关通知归到一组（同一 PR 的评论堆叠）。 */
  threadId?: string;
}

/**
 * 发出一条系统通知。
 *
 * 失败不抛出到界面：一条没弹出来的通知不该打断用户正在做的事。
 */
export function useNotify() {
  return useMutation({
    mutationFn: (args: NotifyArgs) =>
      NotificationService.Send({
        id: args.id,
        title: args.title,
        body: args.body ?? "",
        threadId: args.threadId ?? "",
      }),
  });
}

/**
 * 申请通知权限。
 *
 * 只在用户显式表达"我想收到通知"之后调用：启动时就弹授权请求，
 * 用户还不知道会收到什么，拒绝一次就很难再要回来。
 */
export function useRequestNotificationAuthorization() {
  return useMutation({
    mutationFn: () => NotificationService.RequestAuthorization(),
  });
}
