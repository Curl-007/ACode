/**
 * markdown-table 的文本导出模型（批次 6 外迁）。
 *
 * 承载「复制为 Markdown / 下载 CSV」两条导出路径的纯字符串函数——零 React、零 DOM，
 * 供 `components/ai-elements/markdown-table.tsx` 与单测共用。逐字迁移自原文件顶部，
 * 行为未改动。
 */

export type MarkdownTableRows = string[][];

function normalizeTableCellText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function escapeCsvCell(value: string): string {
  // assistant markdown 属于不可信输入，CSV 被 Excel/Numbers/LibreOffice
  // 打开时会解释公式前缀。下载前统一把公式型单元格降级成纯文本。
  const safeValue = /^[\t\r\n]/u.test(value) || /^[\s]*[=+\-@]/u.test(value) ? `'${value}` : value;

  if (!/[",\r\n]/u.test(safeValue)) {
    return safeValue;
  }

  return `"${safeValue.replace(/"/g, '""')}"`;
}

export function buildMarkdownTableText(rows: MarkdownTableRows): string {
  if (rows.length === 0) {
    return "";
  }

  const columnCount = Math.max(...rows.map((row) => row.length), 1);
  const normalizedRows = rows.map((row) =>
    Array.from({ length: columnCount }, (_, index) => escapeMarkdownTableCell(row[index] ?? "")),
  );
  const header = normalizedRows[0] ?? [];
  const separator = Array.from({ length: columnCount }, () => "---");
  const body = normalizedRows.slice(1);

  return [header, separator, ...body].map((row) => `| ${row.join(" | ")} |`).join("\n");
}

export function buildCsvTableText(rows: MarkdownTableRows): string {
  const csv = rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(",")).join("\r\n");
  // Blob 的 charset 不会写入文件字节，Excel 会把无 BOM 的 UTF-8 CSV
  // 按本地代码页解析，导致中文乱码；显式添加 UTF-8 BOM 让表格软件可靠识别编码。
  return `\uFEFF${csv}`;
}

/** 表格 DOM → 行数组（单元格文本按 `normalizeTableCellText` 归一）。 */
export function readRowsFromTable(table: HTMLTableElement | null): MarkdownTableRows {
  if (!table) {
    return [];
  }

  return Array.from(table.querySelectorAll("tr"))
    .map((row) =>
      Array.from(row.querySelectorAll("th,td")).map((cell) =>
        normalizeTableCellText(cell.textContent ?? ""),
      ),
    )
    .filter((row) => row.length > 0);
}
