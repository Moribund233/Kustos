/**
 * 图标集：从桌面端原型 `docs/prototype/desktop/assets/js/icons.js` 1:1 移植。
 *
 * 保持与原型相同的 24×24 viewBox 与描边路径，这样界面的视觉重量与原型的
 * 稿子一致。新增图标应当同步回原型，否则两边会慢慢分叉。
 */

const PATHS = {
  home: '<path d="M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1Z"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4"/>',
  pr: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M6 8.5v7"/><path d="M18 8.5v3a4 4 0 0 1-4 4H8.5"/>',
  issue: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/>',
  agent: '<path d="M12 3.5 13.8 9.2 19.5 11l-5.7 1.8L12 18.5l-1.8-5.7L4.5 11l5.7-1.8Z"/><path d="M18.5 17.5v3M17 19h3"/>',
  spark: '<path d="M12 3.5 13.8 9.2 19.5 11l-5.7 1.8L12 18.5l-1.8-5.7L4.5 11l5.7-1.8Z"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  command: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3Z"/>',
  chat: '<path d="M20 15.5a2.5 2.5 0 0 1-2.5 2.5H8l-4 3V5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5Z"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m16 16 5 5"/>',
  bell: '<path d="M18 9a6 6 0 1 0-12 0c0 6-2.5 7-2.5 7h17S18 15 18 9Z"/><path d="M10 19.5a2.2 2.2 0 0 0 4 0"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "chevron-right": '<path d="m9 6 6 6-6 6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  "check-double": '<path d="m3 12 4 4 8-8"/><path d="m11 16 1.5 1.5L21 9"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 2"/>',
  play: '<path d="M7.5 4.8v14.4L20 12Z"/>',
  merge: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M6 15.5V9a3 3 0 0 1 3-3h6.5"/><path d="m13 3.5 3 2.5-3 2.5"/>',
  file: '<path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h5"/>',
  folder: '<path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5Z"/>',
  "folder-open": '<path d="M3.5 8V6.5A1.5 1.5 0 0 1 5 5h4l2 2h7a1.5 1.5 0 0 1 1.5 1.5V10"/><path d="M3.5 10h17l-2 8H5.5Z"/>',
  branch: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M18 10.5v1a4 4 0 0 1-4 4H8.5"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6H5V6h6"/>',
  more: '<circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8Z"/>',
  shield: '<path d="M12 3 20 6v6c0 5-3.4 8.2-8 9.5-4.6-1.3-8-4.5-8-9.5V6Z"/><path d="m8.5 12 2.5 2.5 4.5-4.5"/>',
  terminal: '<path d="m4 7 5 5-5 5M12 17h8"/>',
  "arrow-up-right": '<path d="M7 17 17 7M8 7h9v9"/>',
  star: '<path d="m12 3.5 2.7 5.5 6 .9-4.4 4.3 1 6-5.3-2.8-5.3 2.8 1-6L3.3 9.9l6-.9Z"/>',
  fork: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M6 8.5v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-2"/><path d="M12 13.5v2"/>',
  eye: '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/>',
  lock: '<rect x="4.5" y="10" width="15" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c3 3.5 3 14 0 18-3-4-3-14.5 0-18Z"/>',
  send: '<path d="M21 3 10.5 13.5M21 3l-6.5 18-4-7.5L3 10Z"/>',
  paperclip: '<path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 6"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14a5 5 0 0 0 8 0"/><path d="M9 9h.01M15 9h.01"/>',
  pin: '<path d="M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5Z"/><path d="M12 14v6"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
  alert: '<path d="M12 3 22 20H2Z"/><path d="M12 9v5M12 17h.01"/>',
  "check-circle": '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/>',
  "x-circle": '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
  loader: '<path d="M12 3a9 9 0 1 0 9 9"/>',
  "git-commit": '<circle cx="12" cy="12" r="4"/><path d="M3 12h5M16 12h5"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4.5V10H9"/><path d="M12 8v4.5l3 2"/>',
  edit: '<path d="M4 20h4L20 8l-4-4L4 16Z"/><path d="m13.5 6.5 4 4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4"/><path d="M17.5 14.2A6.5 6.5 0 0 1 21.5 20"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>',
  "arrow-left": '<path d="M20 12H4M10 6l-6 6 6 6"/>',
  "panel-left": '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l2 2M15 8l2 2"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7Z"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5Z"/><path d="M4 5.5v16"/>',
  message: '<path d="M20 14.5a2.5 2.5 0 0 1-2.5 2.5H9l-5 4V5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5Z"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a2.5 2.5 0 0 0 5 0v-1a9 9 0 1 0-3.5 7.1"/>',
  diff: '<path d="M6 3v18M18 3v18M3 7h6M15 7h6M3 17h6M15 17h6"/>',
  server: '<rect x="3.5" y="4" width="17" height="6" rx="1.5"/><rect x="3.5" y="14" width="17" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/>',
  database: '<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  pulse: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
  tag: '<path d="M20 13 13 20a2 2 0 0 1-2.8 0L3.5 13.3V3.5H13l7 7a2 2 0 0 1 0 2.5Z"/><circle cx="8" cy="8" r="1.2"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
  download: '<path d="M12 3v12"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4 20h16"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v5M14 11v5"/>',
} as const;

export type IconName = keyof typeof PATHS;

/**
 * 内联 SVG 图标。
 *
 * 用 `dangerouslySetInnerHTML` 而不是手写几十个 `<path>` 组件：
 * 路径是静态可信的常量，且这样能保持与原型同一份数据源。
 */
export function Icon({
  name,
  className,
  size,
}: {
  name: IconName;
  className?: string;
  size?: number;
}) {
  const style = size ? { width: size, height: size } : undefined;
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
    />
  );
}
