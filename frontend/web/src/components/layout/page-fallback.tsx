/** 懒加载页面的占位。 */
export function PageFallback() {
  return (
    <div className="text-faint p-5 text-[13px]" role="status">
      加载中…
    </div>
  );
}
