/**
 * 文件名 → 图标种类的映射表（packages/ui/specs/chat-small-ux-file-icons.md §2）。
 *
 * 上游打包 1146 个专有文件类型图标；ACode 不拷贝还原产物，改为复用仓库既有 lucide 图标
 * 做一张「扩展名 → 图标」的近似表（~45 组），未命中回退通用文件图标。
 *
 * 本模块只做**纯解析**（扩展名/点文件名 → 图标种类字符串），不含任何 React 依赖——
 * 种类 → lucide 组件的接线在 `FileTypeIcon.tsx`，解析规则可以单独被 node --test 钉住。
 * 颜色遵守 DESIGN.md 语义 token：代码/配置族用 `primary`、其余用 foreground 族的
 * 中性表达；图标色不承载状态语义（不借 success/warning/destructive）。
 */

/** 图标种类。字符串而不是组件引用：让解析层保持无 React、可单测。 */
export type FileTypeIconKind =
  | "typescript"
  | "javascript"
  | "json"
  | "web"
  | "style"
  | "markdown"
  | "text"
  | "python"
  | "code"
  | "jvm"
  | "shell"
  | "sql"
  | "database"
  | "spreadsheet"
  | "document"
  | "slides"
  | "pdf"
  | "image"
  | "video"
  | "audio"
  | "archive"
  | "lock"
  | "log"
  | "settings"
  | "container"
  | "font"
  | "data"
  | "file";

/** 点文件/全名匹配（大小写不敏感）：扩展名表达不了的形状。 */
const FILE_NAME_KINDS: Record<string, FileTypeIconKind> = {
  ".env": "settings",
  ".editorconfig": "settings",
  ".gitignore": "settings",
  ".gitattributes": "settings",
  ".npmrc": "settings",
  ".nvmrc": "settings",
  ".prettierrc": "settings",
  ".eslintrc": "settings",
  ".babelrc": "settings",
  dockerfile: "container",
  makefile: "container",
  cmakelists: "container",
  "cargo.lock": "lock",
  "package-lock.json": "lock",
  "pnpm-lock.yaml": "lock",
  "yarn.lock": "lock",
  "bun.lock": "lock",
  gemfile: "code",
  procfile: "shell",
  license: "text",
  readme: "markdown",
};

/** 扩展名（小写、不带点）→ 图标种类。同族扩展名共享一行，行数即「组」数。 */
const EXTENSION_KINDS: Record<string, FileTypeIconKind> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  json: "json",
  jsonc: "json",
  json5: "json",
  html: "web",
  htm: "web",
  xhtml: "web",
  vue: "web",
  svelte: "web",
  astro: "web",
  css: "style",
  scss: "style",
  sass: "style",
  less: "style",
  styl: "style",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  txt: "text",
  text: "text",
  rtf: "text",
  py: "python",
  pyi: "python",
  pyw: "python",
  go: "code",
  rs: "code",
  c: "code",
  h: "code",
  cpp: "code",
  cc: "code",
  cxx: "code",
  hpp: "code",
  hh: "code",
  cs: "code",
  swift: "code",
  kt: "jvm",
  kts: "jvm",
  java: "jvm",
  groovy: "jvm",
  gradle: "jvm",
  scala: "jvm",
  rb: "code",
  php: "code",
  dart: "code",
  lua: "code",
  r: "code",
  jl: "code",
  ex: "code",
  exs: "code",
  erl: "code",
  hs: "code",
  ml: "code",
  graphql: "data",
  gql: "data",
  proto: "data",
  tf: "data",
  toml: "settings",
  yaml: "settings",
  yml: "settings",
  ini: "settings",
  cfg: "settings",
  conf: "settings",
  properties: "settings",
  plist: "settings",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "shell",
  bat: "shell",
  cmd: "shell",
  sql: "sql",
  prisma: "sql",
  db: "database",
  sqlite: "database",
  sqlite3: "database",
  csv: "spreadsheet",
  tsv: "spreadsheet",
  xls: "spreadsheet",
  xlsx: "spreadsheet",
  ods: "spreadsheet",
  numbers: "spreadsheet",
  doc: "document",
  docx: "document",
  odt: "document",
  pages: "document",
  ppt: "slides",
  pptx: "slides",
  odp: "slides",
  key: "slides",
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  ico: "image",
  svg: "image",
  avif: "image",
  heic: "image",
  tiff: "image",
  mp4: "video",
  mkv: "video",
  mov: "video",
  avi: "video",
  webm: "video",
  flv: "video",
  mp3: "audio",
  wav: "audio",
  flac: "audio",
  ogg: "audio",
  m4a: "audio",
  aac: "audio",
  zip: "archive",
  tar: "archive",
  gz: "archive",
  bz2: "archive",
  xz: "archive",
  "7z": "archive",
  rar: "archive",
  zst: "archive",
  lock: "lock",
  log: "log",
  ttf: "font",
  otf: "font",
  woff: "font",
  woff2: "font",
  xml: "data",
  wasm: "code",
  pyc: "python",
};

/** 未命中时的回退种类。 */
export const DEFAULT_FILE_TYPE_ICON_KIND: FileTypeIconKind = "file";

/** 取名字的最后一个 `.` 后段（小写）；无扩展名或以点开头（`.env` 等）返回 undefined。 */
function extensionOf(fileName: string): string | undefined {
  const leaf = fileName.substring(
    Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\")) + 1,
  );
  if (!leaf.includes(".") || leaf.startsWith(".")) return undefined;
  const extension = leaf.substring(leaf.lastIndexOf(".") + 1).toLowerCase();
  return extension.length > 0 ? extension : undefined;
}

/** 取路径叶子名（小写）供全名匹配；`.env.local` 这类带尾巴的点文件按前缀命中。 */
function leafNameOf(fileName: string): string {
  const leaf = fileName.substring(
    Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\")) + 1,
  );
  return leaf.toLowerCase();
}

/**
 * 文件名 → 图标种类。匹配次序：完整点文件/全名 → 带尾巴的点文件前缀（`.env.local`）→
 * 扩展名 → 回退 `file`。空名/纯空白按回退处理，不抛错。
 */
export function resolveFileTypeIconKind(name: string): FileTypeIconKind {
  const trimmed = name.trim();
  if (trimmed.length === 0) return DEFAULT_FILE_TYPE_ICON_KIND;
  const leaf = leafNameOf(trimmed);
  if (leaf.startsWith(".")) {
    // `.env.local` → `.env`；前缀逐级剥尾巴找最长命中。
    const segments = leaf.split(".");
    for (let end = segments.length; end > 1; end -= 1) {
      const candidate = `.${segments.slice(1, end).join(".")}`;
      const kind = FILE_NAME_KINDS[candidate];
      if (kind !== undefined) return kind;
    }
    return DEFAULT_FILE_TYPE_ICON_KIND;
  }
  const byName = FILE_NAME_KINDS[leaf];
  if (byName !== undefined) return byName;
  // 全名匹配也兜一层「带扩展名的惯用名」（Dockerfile.dev → dockerfile）。
  const stem = leaf.includes(".") ? leaf.substring(0, leaf.indexOf(".")) : leaf;
  const byStem = FILE_NAME_KINDS[stem];
  if (byStem !== undefined) return byStem;
  const extension = extensionOf(trimmed);
  if (extension === undefined) return DEFAULT_FILE_TYPE_ICON_KIND;
  return EXTENSION_KINDS[extension] ?? DEFAULT_FILE_TYPE_ICON_KIND;
}
