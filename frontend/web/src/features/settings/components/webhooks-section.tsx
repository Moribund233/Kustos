import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Chip } from "@/components/kit/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api/client";
import { useApiMutation, useApiQuery } from "@/lib/api/hooks";
import { formatRelative } from "@/lib/datetime/format";

/** 后端 WebHook 支持的事件（webhook.py 的 WEBHOOK_EVENTS）。 */
const EVENTS = [
  "push",
  "tag_push",
  "pull_request.opened",
  "pull_request.updated",
  "pull_request.merged",
  "pull_request.closed",
  "pull_request.reopened",
  "release.created",
  "release.published",
  "release.updated",
  "release.deleted",
  "issue.opened",
  "issue.closed",
  "issue.reopened",
  "issue.updated",
  "repository.created",
  "repository.deleted",
  "repository.forked",
];

interface WebhookRow {
  id: string;
  url: string;
  events: string[];
  is_active: boolean;
  last_triggered_at: string | null;
  last_response_status: number | null;
  created_at: string | null;
}

interface DeliveryRow {
  id: string;
  event: string;
  is_success: boolean;
  response_status: number | null;
  duration_ms: number | null;
  created_at: string | null;
}

interface Page<T> {
  items?: T[];
  total?: number;
}

/**
 * Webhook 管理。
 *
 * 创建时常量事件列表与后端 `WEBHOOK_EVENTS` 对齐；URL 会经过后端的
 * SSRF 校验，内网/回环地址会被拒绝。投递记录只读，用于排查回调失败。
 */
export function WebhooksSection({ repoId }: { repoId: string }) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [events, setEvents] = useState<string[]>(["push"]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const listQuery = useApiQuery<WebhookRow[]>({
    queryKey: ["webhooks", repoId],
    enabled: !!repoId,
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/webhooks", {
        params: { path: { repo_id: repoId }, query: { page: 1, limit: 50 } },
      });
      if (res.error) throw new Error("Webhook 加载失败。");
      return (res.data as Page<WebhookRow> | undefined)?.items ?? [];
    },
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["webhooks", repoId] });

  const createMutation = useApiMutation<void, void>(
    async () => {
      const res = await api.POST("/api/v1/repositories/{repo_id}/webhooks", {
        params: { path: { repo_id: repoId } },
        body: {
          url: url.trim(),
          events,
          secret: secret.trim() || undefined,
          is_active: true,
        } as never,
      });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail;
        throw new Error(detail ?? "创建 Webhook 失败。");
      }
    },
    {
      onSuccess: () => {
        toast.success("Webhook 已创建。");
        setUrl("");
        setSecret("");
        setEvents(["push"]);
        void refresh();
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const deleteMutation = useApiMutation<void, string>(
    async (id) => {
      const res = await api.DELETE("/api/v1/repositories/{repo_id}/webhooks/{webhook_id}", {
        params: { path: { repo_id: repoId, webhook_id: id } },
      });
      if (res.error) throw new Error("删除 Webhook 失败。");
    },
    {
      onSuccess: () => {
        toast.success("Webhook 已删除。");
        void refresh();
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const testMutation = useApiMutation<void, string>(
    async (id) => {
      const res = await api.POST("/api/v1/repositories/{repo_id}/webhooks/{webhook_id}/test", {
        params: { path: { repo_id: repoId, webhook_id: id } },
      });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail;
        throw new Error(detail ?? "测试投递失败。");
      }
    },
    {
      onSuccess: () => {
        toast.success("测试事件已发送。");
        void refresh();
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const toggleEvent = (event: string) =>
    setEvents((prev) => (prev.includes(event) ? prev.filter((item) => item !== event) : [...prev, event]));

  const webhooks = listQuery.data ?? [];

  return (
    <section className="border-edge-2 bg-ink-900/50 rounded-[12px] border p-5">
      <h2 className="text-bone text-[13px] font-semibold">Webhook</h2>
      <p className="text-muted-2 mt-1 text-[11px]">
        推送事件到外部地址；URL 会做 SSRF 校验，内网与回环地址会被拒绝。
      </p>

      <div className="mt-4 flex flex-col gap-2">
        {listQuery.isLoading ? (
          <p className="text-muted-2 text-[11.5px]">加载中…</p>
        ) : webhooks.length === 0 ? (
          <p className="text-muted-2 text-[11.5px]">还没有 Webhook。</p>
        ) : (
          webhooks.map((hook) => (
            <div key={hook.id} className="border-edge-1 rounded-md border px-3 py-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label="投递记录"
                  onClick={() => setExpanded((prev) => (prev === hook.id ? null : hook.id))}
                  className="text-muted-2 hover:text-bone-2 transition-colors"
                >
                  {expanded === hook.id ? (
                    <ChevronDown className="size-[13px]" aria-hidden="true" />
                  ) : (
                    <ChevronRight className="size-[13px]" aria-hidden="true" />
                  )}
                </button>
                <span className="text-bone-2 min-w-0 flex-1 truncate font-mono text-[11px]">{hook.url}</span>
                <span className="text-faint text-[10px]">{hook.events.join(", ")}</span>
                <span
                  className={`text-[10px] ${hook.last_response_status && hook.last_response_status < 400 ? "text-sage" : "text-muted-2"}`}
                >
                  {hook.last_response_status ?? "—"}
                </span>
                <button
                  type="button"
                  className="text-muted-2 hover:text-amber-2 text-[10px] transition-colors"
                  onClick={() => testMutation.mutate(hook.id)}
                >
                  测试
                </button>
                <button
                  type="button"
                  aria-label="删除 Webhook"
                  className="text-muted-2 hover:text-rose transition-colors"
                  onClick={() => deleteMutation.mutate(hook.id)}
                >
                  <Trash2 className="size-[13px]" aria-hidden="true" />
                </button>
              </div>
              {expanded === hook.id ? <Deliveries repoId={repoId} webhookId={hook.id} /> : null}
            </div>
          ))
        )}

        <div className="border-edge-1 mt-1 flex flex-col gap-2 border-t pt-3">
          <div className="flex items-center gap-2">
            <Input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/hook"
              aria-label="Webhook 地址"
              className="h-8 font-mono text-[11px]"
            />
            <Input
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder="签名密钥（可选）"
              aria-label="Webhook 密钥"
              className="h-8 text-[11px]"
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {EVENTS.map((event) => (
              <Chip key={event} active={events.includes(event)} onClick={() => toggleEvent(event)}>
                {event}
              </Chip>
            ))}
          </div>
          <Button
            size="sm"
            className="self-start"
            onClick={() => createMutation.mutate()}
            disabled={!url.trim() || events.length === 0 || createMutation.isPending}
          >
            添加 Webhook
          </Button>
        </div>
      </div>
    </section>
  );
}

/** 最近投递记录：只读，展开时才请求。 */
function Deliveries({ repoId, webhookId }: { repoId: string; webhookId: string }) {
  const query = useApiQuery<DeliveryRow[]>({
    queryKey: ["webhook-deliveries", repoId, webhookId],
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/webhooks/{webhook_id}/deliveries", {
        params: { path: { repo_id: repoId, webhook_id: webhookId }, query: { page: 1, limit: 10 } },
      });
      if (res.error) throw new Error("投递记录加载失败。");
      return (res.data as Page<DeliveryRow> | undefined)?.items ?? [];
    },
  });

  const deliveries = query.data ?? [];

  return (
    <div className="border-edge-1 mt-2 border-t pt-2">
      {query.isLoading ? (
        <p className="text-muted-2 text-[10.5px]">加载中…</p>
      ) : deliveries.length === 0 ? (
        <p className="text-muted-2 text-[10.5px]">还没有投递记录。</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {deliveries.map((delivery) => (
            <li key={delivery.id} className="text-faint flex items-center gap-2 font-mono text-[10px]">
              <span className={delivery.is_success ? "text-sage" : "text-rose"}>
                {delivery.is_success ? "ok" : "fail"}
              </span>
              <span>{delivery.event}</span>
              <span>{delivery.response_status ?? "—"}</span>
              <span className="ml-auto">{formatRelative(delivery.created_at ?? "")}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
