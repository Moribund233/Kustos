import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslation } from "react-i18next";

import { api } from "@/lib/api/client";
import { useApiQuery } from "@/lib/api/hooks";

interface DefinitionHit {
  file: string;
  symbol: string;
  kind?: string | null;
  start_line: number;
  end_line: number;
}

interface UsageHit {
  file: string;
  line: number;
  symbol?: string | null;
  kind?: string | null;
  start_line?: number | null;
  end_line?: number | null;
}

interface LookupResponse<T> {
  name: string;
  source?: string;
  partial?: boolean;
  definitions?: T[];
  usages?: T[];
}

/**
 * 符号定义与引用。
 *
 * 走块级索引（默认分支 HEAD）；`source=ref_scan` 表示索引未覆盖该 ref、
 * 结果来自现场扫描，`partial` 为真说明可能被护栏截断。
 */
export function SymbolLookupDialog({
  repoId,
  name,
  open,
  onOpenChange,
  onOpenFile,
}: {
  repoId: string;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenFile: (path: string, line: number) => void;
}) {
  const { t } = useTranslation();
  const definitionQuery = useApiQuery<LookupResponse<DefinitionHit>>({
    queryKey: ["symbol-definition", repoId, name],
    enabled: open && !!repoId && !!name,
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/symbols/{name}/definition", {
        params: { path: { repo_id: repoId, name } },
      });
      if (res.error) throw new Error(t("code.definitionLoadFailed"));
      return res.data as unknown as LookupResponse<DefinitionHit>;
    },
  });

  const usageQuery = useApiQuery<LookupResponse<UsageHit>>({
    queryKey: ["symbol-usages", repoId, name],
    enabled: open && !!repoId && !!name,
    queryFn: async () => {
      const res = await api.GET("/api/v1/repositories/{repo_id}/symbols/{name}/usages", {
        params: { path: { repo_id: repoId, name } },
      });
      if (res.error) throw new Error(t("code.usageLoadFailed"));
      return res.data as unknown as LookupResponse<UsageHit>;
    },
  });

  const definitions = definitionQuery.data?.definitions ?? [];
  const usages = usageQuery.data?.usages ?? [];
  const partial = definitionQuery.data?.partial || usageQuery.data?.partial;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[720px]">
        <DialogHeader>
          <DialogTitle>{t("code.symbolTitle")} · {name}</DialogTitle>
          <DialogDescription>
            {t("code.lookupHint")}
            {partial ? <span className="text-amber-2"> {t("code.truncated")}</span> : null}
          </DialogDescription>
        </DialogHeader>

        <div className="grid max-h-[54vh] grid-cols-2 gap-3 overflow-auto">
          <section aria-label={t("code.definition")} className="border-edge-1 min-h-[160px] rounded-md border">
            <h3 className="border-edge-1 text-muted-2 border-b px-3 py-2 text-2xs font-semibold tracking-[0.12em] uppercase">
              {t("code.definition")} · {definitions.length}
            </h3>
            {definitionQuery.isLoading ? (
              <p className="text-muted-2 p-3 text-xs">{t("common.loading")}</p>
            ) : definitions.length === 0 ? (
              <p className="text-muted-2 p-3 text-xs">{t("code.noDefinition")}</p>
            ) : (
              <ul>
                {definitions.map((hit) => (
                  <li key={`${hit.file}-${hit.start_line}`}>
                    <button
                      type="button"
                      onClick={() => onOpenFile(hit.file, hit.start_line)}
                      className="border-edge-1 hover:bg-ink-800/50 block w-full border-b px-3 py-2 text-left transition-colors last:border-b-0"
                    >
                      <span className="text-bone-2 block truncate font-mono text-xs">{hit.file}</span>
                      <span className="text-faint block text-2xs">
                        L{hit.start_line}–{hit.end_line} · {hit.kind ?? "symbol"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label={t("code.usages")} className="border-edge-1 min-h-[160px] rounded-md border">
            <h3 className="border-edge-1 text-muted-2 border-b px-3 py-2 text-2xs font-semibold tracking-[0.12em] uppercase">
              {t("code.usages")} · {usages.length}
            </h3>
            {usageQuery.isLoading ? (
              <p className="text-muted-2 p-3 text-xs">{t("common.loading")}</p>
            ) : usages.length === 0 ? (
              <p className="text-muted-2 p-3 text-xs">{t("code.noUsages")}</p>
            ) : (
              <ul>
                {usages.map((hit) => (
                  <li key={`${hit.file}-${hit.line}`}>
                    <button
                      type="button"
                      onClick={() => onOpenFile(hit.file, hit.line)}
                      className="border-edge-1 hover:bg-ink-800/50 block w-full border-b px-3 py-2 text-left transition-colors last:border-b-0"
                    >
                      <span className="text-bone-2 block truncate font-mono text-xs">{hit.file}</span>
                      <span className="text-faint block text-2xs">
                        L{hit.line}
                        {hit.symbol ? ` · 在 ${hit.symbol}` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
