interface PlaceholderPageProps {
  title: string;
  hint?: string;
}

/** 骨架阶段的占位页：只标出区块边界，页面实现时逐个替换。 */
export function PlaceholderPage({ title, hint }: PlaceholderPageProps) {
  return (
    <section className="p-5">
      <div className="rounded-panel border-edge-2 bg-ink-900/60 border border-dashed p-6">
        <p className="text-faint text-2xs tracking-[0.15em] uppercase">{title}</p>
        <p className="text-muted mt-2 text-sm">{hint ?? "页面尚未实现。"}</p>
      </div>
    </section>
  );
}
