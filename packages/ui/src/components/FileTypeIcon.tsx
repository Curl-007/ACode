import { memo } from "react";
import {
  AudioLines,
  Braces,
  Coffee,
  Container,
  Database,
  FileArchive,
  FileCode,
  FileCode2,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FileOutput,
  FileSliders,
  FileSpreadsheet,
  FileText,
  FileType,
  FileVideo,
  Globe,
  Palette,
  Presentation,
  SquareTerminal,
  Table,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { resolveFileTypeIconKind, type FileTypeIconKind } from "@/components/fileTypeIconMap.js";

/**
 * 文件类型图标（packages/ui/specs/chat-small-ux-file-icons.md §2）。
 *
 * `<FileTypeIcon name={fileName} className? />`：按文件名解析扩展名 → lucide 图标，未命中
 * 回退通用文件图标。纯展示、memo——名字不变就不重解析重渲染。
 *
 * 着色只用两档中性表达（DESIGN.md：图标色不承载状态语义、不引入 raw 色值新调色板）：
 * 代码/数据族用 `text-primary`，其余用 foreground 族的中性档；类型区分靠**形状**而不是
 * 色相，深浅主题下都读得出。
 */
const KIND_ICON: Record<FileTypeIconKind, typeof FileType> = {
  typescript: FileCode2,
  javascript: FileCode,
  json: FileJson,
  web: Globe,
  style: Palette,
  markdown: FileText,
  text: FileType,
  python: Braces,
  code: FileCode,
  jvm: Coffee,
  shell: SquareTerminal,
  sql: Database,
  database: Database,
  spreadsheet: FileSpreadsheet,
  document: FileText,
  slides: Presentation,
  pdf: FileType,
  image: FileImage,
  video: FileVideo,
  audio: AudioLines,
  archive: FileArchive,
  lock: FileLock,
  log: FileOutput,
  settings: FileCog,
  container: Container,
  font: FileSliders,
  data: Table,
  file: FileType,
};

/** 代码/数据族的一档强调色；其余走 foreground 中性档。 */
const KIND_EMPHASIZED: ReadonlySet<FileTypeIconKind> = new Set([
  "typescript",
  "javascript",
  "json",
  "python",
  "code",
  "jvm",
  "data",
  "sql",
]);

export const FileTypeIcon = memo(function FileTypeIcon({
  className,
  name,
}: {
  /** 额外类（尺寸随消费点定，如 `size-3.5`）。 */
  className?: string;
  /** 文件名（可带路径）。 */
  name: string;
}) {
  const kind = resolveFileTypeIconKind(name);
  const Icon = KIND_ICON[kind];
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        KIND_EMPHASIZED.has(kind) ? "text-primary" : "text-foreground-subtle",
        className,
      )}
      data-file-type={kind}
    />
  );
});
