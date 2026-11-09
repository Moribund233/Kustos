/**
 * 按文件扩展名推断语言。
 *
 * 与后端 `repository_browser_service.py` 的语言判定保持同一套口径，
 * 前端只用于选择高亮器，判定不准也不影响功能，因此不必完全复刻后端逻辑。
 */
const EXTENSION_LANGUAGES: Record<string, string> = {
  py: "python",
  pyi: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  json: "json",
  jsonc: "json",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  sql: "sql",
  rs: "rust",
  go: "go",
  java: "java",
  php: "php",
  rb: "ruby",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  kt: "kotlin",
  swift: "swift",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  svg: "xml",
  vue: "vue",
  svelte: "svelte",
  lua: "lua",
  r: "r",
  scala: "scala",
  dart: "dart",
  ex: "elixir",
  exs: "elixir",
  hs: "haskell",
  jl: "julia",
  pl: "perl",
  txt: "text",
  lock: "text",
  env: "bash",
  dockerfile: "dockerfile",
  makefile: "makefile",
  mk: "makefile",
  gradle: "groovy",
  tf: "hcl",
  hcl: "hcl",
  proto: "protobuf",
  graphql: "graphql",
  gql: "graphql",
};

const FILENAME_LANGUAGES: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  rakefile: "ruby",
  gemfile: "ruby",
  procfile: "text",
  jenkinsfile: "groovy",
};

/**
 * 推断文件语言标识。
 *
 * @param path 文件路径或文件名
 * @returns 语言标识；无法识别时返回 "text"
 */
export function detectLanguage(path: string): string {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (!name) return "text";

  const byName = FILENAME_LANGUAGES[name];
  if (byName) return byName;

  // Dockerfile.prod 这类带后缀的文件名，先尝试完整名再取扩展名
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "text";
  const ext = name.slice(dot + 1);
  return EXTENSION_LANGUAGES[ext] ?? "text";
}

/**
 * 判断文件是否可能是二进制。
 *
 * 后端 blob 接口会给出大小与内容，是否二进制由前端粗判：
 * 内容含大量 NUL 字节即视为二进制，不做解码渲染。
 */
export function looksBinary(content: string): boolean {
  const sample = content.slice(0, 8000);
  let control = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i);
    // 允许 \t \n \r 之外的 C0 控制字符
    if (code === 0) return true;
    if (code < 9 || (code > 13 && code < 32)) control += 1;
  }
  return sample.length > 0 && control / sample.length > 0.3;
}
