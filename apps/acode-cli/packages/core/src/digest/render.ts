// ============================================================
// Digest markdown 渲染（specs/periodic-digest.md R1/R3/R5/R7）
// ============================================================
// 纯函数：DigestDocument → markdown 全文（会话存储产物 + 后续渲染批次的投影底稿）。
// 头部一次性携带数据非指令声明（R3）；条目文本再做一次防御性单行化；全文按字节
// 上限尾部截断（R5，notification-primitives 同款口径）。本波不做 UI/TUI 渲染（R7）。

import {
  DIGEST_MAX_MARKDOWN_BYTES,
  DIGEST_UNTRUSTED_NOTICE,
  type DigestDocument,
} from "./types.js";

function oneLine(value: string): string {
  return value.replace(/\r?\n/gu, " ").trim();
}

function isoOrUndefined(ms: number | undefined): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function withSince(text: string, since: number | undefined): string {
  const iso = isoOrUndefined(since);
  return iso ? `${text} (since ${iso})` : text;
}

function renderInProgress(doc: DigestDocument): string[] {
  const items = doc.sections.inProgress;
  const lines = [`## In progress (${items.length})`];
  if (items.length === 0) return [...lines, "(none)"];
  for (const item of items) {
    const detail = item.detail ? ` — ${oneLine(item.detail)}` : "";
    lines.push(
      `- [${item.kind}] ${oneLine(item.title)} — ${oneLine(item.state)}${detail} \`${item.id}\``,
    );
  }
  return lines;
}

function renderAttention(doc: DigestDocument): string[] {
  const items = doc.sections.attention;
  const lines = [`## Needs attention (${items.length})`];
  if (items.length === 0) return [...lines, "(none)"];
  for (const item of items) {
    lines.push(
      `- [${item.kind}] ${oneLine(item.title)} — ${withSince(oneLine(item.reason), item.since)} \`${item.id}\``,
    );
  }
  return lines;
}

function renderRoutines(doc: DigestDocument): string[] {
  const items = doc.sections.routines;
  const lines = [`## Scheduled routines (${items.length})`];
  if (items.length === 0) return [...lines, "(none)"];
  for (const item of items) {
    const facts: string[] = [oneLine(item.cadence), item.state];
    const next = isoOrUndefined(item.nextRunAt);
    if (next) facts.push(`next ${next}`);
    const last = isoOrUndefined(item.lastRunAt);
    if (last) facts.push(`last ${last}`);
    facts.push(
      typeof item.maxRuns === "number"
        ? `runs ${item.runCount}/${item.maxRuns}`
        : `runs ${item.runCount}`,
    );
    lines.push(`- ${oneLine(item.title)} — ${facts.join("; ")} \`${item.automationId}\``);
  }
  return lines;
}

function renderArtifacts(doc: DigestDocument): string[] {
  const items = doc.sections.artifacts;
  const lines = [`## Artifacts (${items.length})`];
  if (items.length === 0) return [...lines, "(none)"];
  for (const item of items) {
    const label = item.title ? `${oneLine(item.title)} (${item.kind})` : item.kind;
    const flags = [`v${item.version}`];
    if (item.primary === true) flags.push("primary");
    lines.push(
      `- ${label} [${flags.join(", ")}] — run ${oneLine(item.runLabel)} \`${item.runId}\``,
    );
  }
  return lines;
}

function renderOverflow(doc: DigestDocument): string[] {
  const overflow = doc.overflow;
  if (!overflow) return [];
  const parts: string[] = [];
  if (typeof overflow.inProgress === "number")
    parts.push(`${overflow.inProgress} more in-progress`);
  if (typeof overflow.attention === "number") parts.push(`${overflow.attention} more attention`);
  if (typeof overflow.artifacts === "number") parts.push(`${overflow.artifacts} more artifacts`);
  return parts.length > 0 ? [`> Truncated sections: ${parts.join(", ")}.`] : [];
}

/** 按字节上限在行边界尾部截断；截断即追加标记（R5）。 */
export function clampDigestMarkdownBytes(markdown: string): string {
  if (Buffer.byteLength(markdown, "utf8") <= DIGEST_MAX_MARKDOWN_BYTES) return markdown;
  const lines = markdown.split("\n");
  const kept: string[] = [];
  let bytes = Buffer.byteLength("[truncated]\n", "utf8");
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
    if (bytes + lineBytes > DIGEST_MAX_MARKDOWN_BYTES) break;
    kept.push(line);
    bytes += lineBytes;
  }
  return `${kept.join("\n")}\n[truncated]\n`;
}

export function renderDigestMarkdown(doc: DigestDocument): string {
  const lines: string[] = [
    `# Workspace Digest — ${new Date(doc.generatedAt).toISOString()}`,
    "",
    `> ${DIGEST_UNTRUSTED_NOTICE}`,
    "",
    ...renderInProgress(doc),
    "",
    ...renderAttention(doc),
    "",
    ...renderRoutines(doc),
    "",
    ...renderArtifacts(doc),
    "",
    ...renderOverflow(doc),
  ];
  if (doc.sourceWarnings.length > 0) {
    lines.push("", `## Source warnings (${doc.sourceWarnings.length})`);
    for (const code of doc.sourceWarnings) lines.push(`- ${code}`);
  }
  return clampDigestMarkdownBytes(`${lines.join("\n").trimEnd()}\n`);
}
