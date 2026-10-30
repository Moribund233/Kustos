import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getAccessToken } from "@/lib/api/client";
import { useApiMutation, useApiQuery } from "@/lib/api/hooks";

/** 标签行（label_service / pr_label_service 返回模型字段）。 */
interface LabelRow {
  id: string;
  name: string;
  color?: string | null;
  description?: string | null;
}

const DEFAULT_COLOR = "#f2ae5b";

/** Issue/PR 标签接口按类型分路径，统一用 fetch 发请求，避免动态路径绕过类型。 */
async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  const token = getAccessToken();
  const res = await fetch(path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(payload.detail ?? `请求失败（${res.status}）。`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

/**
 * 仓库标签管理。
 *
 * Issue 标签与 PR 标签在 Kusto 里是两套定义（`/labels` 与 `/pr-labels`），
 * 这里用同一个编辑器分别渲染，避免把两者混成一张表。
 */
export function LabelsSection({ repoId }: { repoId: string }) {
  const { t } = useTranslation();
  return (
    <section className="border-edge-2 bg-ink-900/50 rounded-[12px] border p-5">
      <h2 className="text-bone text-base font-semibold">{t("settings.labels")}</h2>
      <p className="text-muted-2 mt-1 text-xs">
        {t("settings.labelsHint")}
      </p>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <LabelEditor repoId={repoId} kind="issue" title={t("settings.issueLabels")} />
        <LabelEditor repoId={repoId} kind="pr" title={t("settings.prLabels")} />
      </div>
    </section>
  );
}

function LabelEditor({ repoId, kind, title }: { repoId: string; kind: "issue" | "pr"; title: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const base = `/api/v1/repositories/${repoId}/${kind === "issue" ? "labels" : "pr-labels"}`;
  const queryKey = ["repo-labels", repoId, kind];

  const [name, setName] = useState("");
  const [color, setColor] = useState(DEFAULT_COLOR);

  const listQuery = useApiQuery<LabelRow[]>({
    queryKey,
    enabled: !!repoId,
    queryFn: async () => {
      const data = await request("GET", base);
      return (Array.isArray(data) ? data : []) as LabelRow[];
    },
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey });

  const createMutation = useApiMutation<void, void>(
    async () => {
      await request("POST", base, { name: name.trim(), color });
    },
    {
      onSuccess: () => {
        toast.success(t("settings.labelCreated"));
        setName("");
        void refresh();
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const deleteMutation = useApiMutation<void, string>(
    async (labelId) => {
      await request("DELETE", `${base}/${labelId}`);
    },
    {
      onSuccess: () => {
        toast.success(t("settings.labelDeleted"));
        void refresh();
      },
      onError: (error) => toast.error(error.message),
    },
  );

  return (
    <div className="border-edge-1 rounded-md border p-3">
      <h3 className="text-muted text-xs font-semibold tracking-[0.08em] uppercase">{title}</h3>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {(listQuery.data ?? []).length === 0 ? (
          <li className="text-muted-2 text-xs">{t("settings.noLabels")}</li>
        ) : (
          (listQuery.data ?? []).map((label) => (
            <li key={label.id}>
              <span
                className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs"
                style={{
                  borderColor: `${label.color ?? DEFAULT_COLOR}55`,
                  backgroundColor: `${label.color ?? DEFAULT_COLOR}14`,
                  color: label.color ?? DEFAULT_COLOR,
                }}
              >
                {label.name}
                <button
                  type="button"
                  aria-label={t("common.delete")}
                  className="opacity-60 transition-opacity hover:opacity-100"
                  onClick={() => deleteMutation.mutate(label.id)}
                >
                  <Trash2 className="size-[11px]" aria-hidden="true" />
                </button>
              </span>
            </li>
          ))
        )}
      </ul>
      <div className="mt-3 flex items-center gap-1.5">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("settings.labelName")}
          aria-label={`${title} ${t("settings.labelName")}`}
          className="h-8 text-xs"
        />
        <input
          type="color"
          value={color}
          onChange={(event) => setColor(event.target.value)}
          aria-label={`${title} ${t("settings.tagColor")}`}
          className="border-edge-2 bg-ink-950/60 h-8 w-9 rounded-md border p-0.5"
        />
        <Button
          size="sm"
          onClick={() => createMutation.mutate()}
          disabled={!name.trim() || createMutation.isPending}
        >
          {t("common.add")}
        </Button>
      </div>
    </div>
  );
}
