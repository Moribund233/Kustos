import { useEffect, useState } from "react";
import { toast } from "sonner";

import { CodeView } from "@/components/editor/code-view";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api/client";
import { useApiMutation } from "@/lib/api/hooks";

/**
 * 网页编辑文件并提交。
 *
 * 走 `PUT /contents/{file_path}`：后端在目标分支上生成一次提交（作者取当前
 * 用户），分支保护由后端裁决，前端不预判。保存成功后由页面刷新 blob / 树 /
 * 最近提交。
 */
export function FileEditDialog({
  repoId,
  branch,
  path,
  initialContent,
  open,
  onOpenChange,
  onSaved,
}: {
  repoId: string;
  branch: string;
  path: string;
  initialContent: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [content, setContent] = useState(initialContent);
  const [message, setMessage] = useState("");

  // 每次打开都用最新磁盘内容重置，避免沿用上一次编辑的草稿
  useEffect(() => {
    if (open) {
      setContent(initialContent);
      setMessage(`Update ${path}`);
    }
  }, [open, initialContent, path]);

  const saveMutation = useApiMutation<void, { content: string; message: string }>(
    async (input) => {
      const res = await api.PUT("/api/v1/repositories/{repo_id}/contents/{file_path}", {
        params: { path: { repo_id: repoId, file_path: path } },
        body: { content: input.content, message: input.message, branch } as never,
      });
      if (res.error) {
        const detail = (res.error as { detail?: string }).detail;
        throw new Error(detail ?? "保存失败。");
      }
    },
    {
      onSuccess: () => {
        toast.success("已提交到分支。");
        onOpenChange(false);
        onSaved();
      },
      onError: (error) => toast.error(error.message),
    },
  );

  const changed = content !== initialContent;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[1100px]">
        <DialogHeader>
          <DialogTitle>编辑文件</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{path}</span> · {branch} · 保存会生成一次提交
          </DialogDescription>
        </DialogHeader>

        <div className="border-edge-1 h-[54vh] min-h-[320px] overflow-hidden rounded-md border">
          <CodeView
            content={content}
            path={path}
            readOnly={false}
            onChange={setContent}
            className="h-full"
          />
        </div>

        <Input
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="提交信息"
          aria-label="提交信息"
        />

        <DialogFooter>
          <span className="text-faint mr-auto self-center text-[10.5px]">
            {changed ? "有未提交的修改" : "内容未改变"}
          </span>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={() =>
              saveMutation.mutate({ content, message: message.trim() || `Update ${path}` })
            }
            disabled={!changed || saveMutation.isPending}
          >
            {saveMutation.isPending ? "提交中…" : "提交"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
