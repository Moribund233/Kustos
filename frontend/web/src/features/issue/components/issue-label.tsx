import { cn } from "@/lib/utils";

/** 标签着色：与原型 issues.css 的 is-* 系列同源。 */
const LABEL_CLASS: Record<string, string> = {
  agent: "border-amber/40 bg-amber/10 text-amber",
  reliability: "border-rose/40 bg-rose/10 text-rose",
  search: "border-sky/40 bg-sky/10 text-sky",
  performance: "border-[#c9b37e]/40 bg-[#c9b37e]/10 text-[#c9b37e]",
  realtime: "border-sage/40 bg-sage/10 text-sage",
  bug: "border-rose/40 bg-rose/10 text-rose",
  admin: "border-edge-2 bg-bone/5 text-muted",
  lfs: "border-sky/40 bg-sky/10 text-sky",
  frontend: "border-sage/40 bg-sage/10 text-sage",
  pr: "border-amber/40 bg-amber/10 text-amber",
};

/** 标签小徽标：描边同色 + wash 底；未知标签回落到中性色。 */
export function IssueLabel({ label }: { label: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-[17px] items-center rounded-full border px-1.5 text-[9px] leading-none whitespace-nowrap opacity-90",
        LABEL_CLASS[label] ?? LABEL_CLASS.admin,
      )}
    >
      {label}
    </span>
  );
}
