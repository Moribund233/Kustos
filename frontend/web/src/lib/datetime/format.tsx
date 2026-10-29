import { formatDateTime, formatRelative, toIsoString } from "@/lib/datetime/format";

/**
 * 带相对量的时间戳，鼠标悬停显示绝对时间。
 *
 * @param value 时间值
 * @returns React 节点
 */
export function TimeStamp({ value }: { value: string | number | Date | null | undefined }) {
  if (!value) return null;
  return (
    <time dateTime={toIsoString(value)} title={formatDateTime(value)}>
      {formatRelative(value)}
    </time>
  );
}
