import { useEffect, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Events } from "@wailsio/runtime";

import { NotificationService } from "@/bindings/github.com/kustos/kustos-desktop/internal/services";
import { NotificationActivated as NotificationActivatedEvent } from "@/bindings/events";

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

/** 通知上的一个动作按钮。 */
export interface NotifyAction {
  /** 动作标识，用户点击后原样回到 `useNotificationActions`。 */
  id: string;
  /** 按钮文案。 */
  title: string;
}

/** 一条带动作按钮的通知。 */
export interface ActionableNotifyArgs extends NotifyArgs {
  /** 动作组标识；同一组按钮注册一次即可复用。 */
  categoryId: string;
  /**
   * 按钮清单，一到三个。
   *
   * 上限三个是系统的限制（Windows 通知最多放三个），超过会被静默截断；
   * Go 侧直接拒绝，这里也按同一口径校验。
   */
  actions: NotifyAction[];
  /** 随通知带上的附加数据，用户点击后原样回到回调里。 */
  data?: Record<string, string>;
}

/**
 * 发出一条带动作按钮的通知。
 *
 * 按钮本身不带权限判断：点了之后界面拿到的是一个标识，真正的动作（批准、
 * 打开某个 PR）仍要经服务端裁决。桌面端不在通知里多开一条旁路。
 */
export function useNotifyWithActions() {
  return useMutation({
    mutationFn: (args: ActionableNotifyArgs) =>
      NotificationService.SendActionable({
        categoryId: args.categoryId,
        actions: args.actions.map((action) => ({ id: action.id, title: action.title })),
        request: {
          id: args.id,
          title: args.title,
          body: args.body ?? "",
          threadId: args.threadId ?? "",
        },
        data: args.data ?? {},
      }),
  });
}

/** 用户对通知的响应。 */
export interface NotificationActivated {
  notificationId: string;
  /** 被点击的按钮标识；点了通知正文时为空串。 */
  actionId: string;
  categoryId: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

/**
 * 订阅"用户点了通知"的回调。
 *
 * Args:
 *
 *	onActivate: 收到响应时调用；只在窗口存活期间订阅，卸载即取消。
 *	enabled:    会话就绪后才订阅——未登录时执行不了任何动作。
 *
 * 回调里**不直接改本地状态**：动作要经服务端确认（比如批准 PR 是一次写请求），
 * 成功后由对应的 mutation 失效缓存，界面才会更新。
 */
export function useNotificationActions(
  onActivate: (event: NotificationActivated) => void,
  enabled: boolean,
): void {
  const handler = useRef(onActivate);
  handler.current = onActivate;

  useEffect(() => {
    if (!enabled) return;
    const off = Events.On(NotificationActivatedEvent, (event) => {
      const payload = event.data as NotificationActivated | null;
      if (payload == null) return;
      handler.current(payload);
    });
    return off;
  }, [enabled]);
}
