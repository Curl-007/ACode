// ============================================================
// Read Tool - skill:// scheme branch
// ============================================================
// 机制参照 oh-my-pi (MIT) — packages/coding-agent/src/internal-urls/skill-protocol.ts
// 与 docs/skills.md「skill:// URL behavior」（沙箱化技能资产读协议：裸名=SKILL.md、
// 子路径=技能目录内资产、拒绝对路径/`..`/越界、realpath 防 symlink 逃逸、目录给列表、
// 缺失显式报错；其 MCP 兜底不移植），按 ACode SkillPort 面重写。
// Copyright (c) 2025 Mario Zechner & Stencil Labs.
//
// 规格：specs/skill-uri-read.md（R1 语法 / R2 发现赢家 / R3 沙箱规则表 / R4 错误契约）。
// 解析产出物理路径后交回 read.ts 既有管线（行号/offset/limit/缓存/媒体分派全复用）。

import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { CoreErrorType, createCoreError, type SkillMetadata } from "@acode/contracts";
import type { ToolExecutionContext } from "../types.js";

const SKILL_URI_PREFIX = "skill://";
/** 资产清单一层列表的条目上限（R4 `<listing>`）。 */
const MAX_LISTING_ENTRIES = 100;
/** Unknown skill 错误里可命中名清单的上限（R4-E5）。 */
const MAX_AVAILABLE_IDS = 200;
/** Windows 盘符形（含大小写盘符）跨平台一律按绝对路径拒绝（R3.3，宁紧勿松）。 */
const DRIVE_LETTER_PATTERN = /^[A-Za-z]:/;
/** 全斜杠路径（`/`、`//`、`\`）= 寻址技能目录本身（R1）。 */
const ALL_SEPARATORS_PATTERN = /^[\\/]+$/;

/** file_path 是否为 skill:// URI（scheme 前缀大小写不敏感，R1）。 */
export function isSkillUri(inputPath: string): boolean {
  return inputPath.toLowerCase().startsWith(SKILL_URI_PREFIX);
}

/**
 * 把 skill:// URI 解析为技能目录内的物理文件路径（R1-R3 全量校验后返回）。
 * 失败一律抛 R4 契约的 CoreError（ToolExecutionFailed, recoverable）——这些是
 * 模型可自纠的业务性拒绝，不是宿主配置故障。
 */
export async function resolveSkillUriToPhysicalPath(
  inputPath: string,
  context: ToolExecutionContext,
): Promise<string> {
  const skillPort = context.skillPort;
  if (!skillPort) {
    // E4：技能注册表缺席（特性关闭/未接线）。不做任何路径回退搜索。
    throw skillUriError(
      "skill_uri_unavailable",
      "skill:// reads are unavailable: no skill registry is configured for this session. " +
        "If you know the skill's absolute path, read that path directly.",
    );
  }

  const uri = inputPath;
  const { name, relativePath } = parseSkillUri(uri);

  // R2：发现与赢家语义复用 SkillPort.discoverSkills + loadSkill 同款 find-first。
  const outcome = await skillPort.discoverSkills(
    { workingDirectory: context.workingDirectory },
    { signal: context.abortSignal },
  );
  const skill = outcome.skills.find(
    (candidate) => candidate.name === name || candidate.qualifiedName === name,
  );
  if (!skill) {
    // E5：未知技能 + 全部可命中名清单（模型自纠面）。
    throw skillUriError(
      "skill_uri_unknown_skill",
      `Unknown skill: "${name}". Available skills: ${formatAvailableIds(outcome.skills)}. ` +
        "Read skill://<name> for a skill's SKILL.md, or skill://<name>/<relative-path> for an asset.",
      { skillName: name },
    );
  }

  // R1：裸名 / 结尾单斜杠 → SKILL.md 原始全文（发现链已保证其存在与可加载性；
  // 用户级 symlink 导入技能的 SKILL.md 路径本身即受支持形态，不再二次 realpath）。
  if (relativePath === undefined || relativePath === "") return skill.path;
  // 全斜杠 = 寻址技能目录本身 → 目录列表错误（E10）。
  if (ALL_SEPARATORS_PATTERN.test(relativePath)) {
    throw await createDirectoryTargetError(`${SKILL_URI_PREFIX}${name}/`, skill.directory, name);
  }

  const target = await resolveSandboxedTarget(uri, name, relativePath, skill);
  return await assertReadableFileTarget(uri, name, target, skill);
}

// ------------------------------------------------------------
// URI 解析（R1/R3.1/R3.2）
// ------------------------------------------------------------

interface ParsedSkillUri {
  name: string;
  /** undefined = 裸名形（无第一个 `/`）。 */
  relativePath: string | undefined;
}

function parseSkillUri(uri: string): ParsedSkillUri {
  // 前缀已按大小写不敏感匹配；截掉固定长度前缀保留原文大小写。
  const body = uri.slice(SKILL_URI_PREFIX.length);
  const slash = body.indexOf("/");
  const rawName = slash === -1 ? body : body.slice(0, slash);
  const rawPath = slash === -1 ? undefined : body.slice(slash + 1);

  const name = decodeSkillUriPart(rawName, uri);
  if (name.length === 0) {
    // E1：空名（`skill://`、`skill:///x`）。
    throw skillUriError(
      "skill_uri_malformed",
      `Invalid skill:// URI: "${uri}". Expected skill://<name> (reads the skill's SKILL.md) ` +
        "or skill://<name>/<relative-path> (reads an asset inside that skill's directory).",
    );
  }
  assertNoControlCharacters(uri, name);

  if (rawPath === undefined) return { name, relativePath: undefined };
  const relativePath = decodeSkillUriPart(rawPath, uri);
  assertNoControlCharacters(uri, relativePath);
  return { name, relativePath };
}

function decodeSkillUriPart(part: string, uri: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    // E1 同族：percent 解码失败（如孤立 `%zz`）。
    throw skillUriError(
      "skill_uri_malformed",
      `Invalid percent-encoding in skill:// URI: "${uri}". Use the literal path text instead.`,
    );
  }
}

function assertNoControlCharacters(uri: string, decoded: string): void {
  if (decoded.includes("\0")) {
    // E3：NUL 截断攻击面（foo.md%00.png 形态）直接拒绝。
    throw skillUriError(
      "skill_uri_sandbox_rejected",
      `Rejected skill:// path: control characters are not allowed: "${uri}".`,
      { rule: "control-character" },
    );
  }
}

// ------------------------------------------------------------
// 沙箱（R3.3-R3.5 词法层）
// ------------------------------------------------------------

/**
 * 词法沙箱：拒绝绝对路径/盘符形/`..` 段，再做 resolve 包含校验（纵深防御），
 * 返回技能目录内的词法物理路径。本层不触碰文件系统；拒绝文案按 R4 附资产清单。
 */
async function resolveSandboxedTarget(
  uri: string,
  name: string,
  relativePath: string,
  skill: SkillMetadata,
): Promise<string> {
  if (
    isAbsolute(relativePath) ||
    DRIVE_LETTER_PATTERN.test(relativePath) ||
    relativePath.startsWith("/") ||
    relativePath.startsWith("\\")
  ) {
    // E6：绝对路径（含 Windows 大小写盘符、UNC、根相对形）。
    throw await createSandboxRejectedError("absolute-path", name, skill, [
      `Rejected skill:// path: absolute paths are not allowed ("${relativePath}").`,
      "Paths are relative to the skill directory.",
    ]);
  }

  // R3.4：decode 后按两类分隔符切段，任一段恰为 `..` 即拒（覆盖 `..\`、混合分隔符）。
  if (relativePath.split(/[\\/]/).includes("..")) {
    // E7：路径穿越。
    throw await createSandboxRejectedError("path-traversal", name, skill, [
      `Rejected skill:// path: ".." segments are not allowed ("${relativePath}").`,
      "Paths are relative to the skill directory.",
    ]);
  }

  const skillDirectory = resolve(skill.directory);
  const target = resolve(skillDirectory, relativePath);
  if (!isWithinRoot(skillDirectory, target)) {
    // R3.5 词法包含失败（R3.3/R3.4 之后理论上不可达，纵深防御仍按穿越文案拒绝）。
    throw await createSandboxRejectedError("path-traversal", name, skill, [
      `Rejected skill:// path: ".." segments are not allowed ("${relativePath}").`,
      "Paths are relative to the skill directory.",
    ]);
  }
  return target;
}

/** win32 文件系统大小写不敏感：包含比较按平台语义（规格 R3.5/R3.6）。 */
function isWithinRoot(root: string, target: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (process.platform === "win32") {
    const lowerRoot = normalizedRoot.toLowerCase();
    const lowerTarget = normalizedTarget.toLowerCase();
    return lowerTarget === lowerRoot || lowerTarget.startsWith(lowerRoot + sep);
  }
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + sep);
}

// ------------------------------------------------------------
// 沙箱（R3.6/R3.7 realpath 层）+ 目标类型判定
// ------------------------------------------------------------

/**
 * realpath 包含校验（捕获资产级 symlink/junction 逃逸，含中间目录链接）与
 * 目标类型判定。返回交回既有读取管线的词法路径（保持技能目录形态的身份稳定；
 * TOCTOU 窗口见规格「已知限制」）。
 */
async function assertReadableFileTarget(
  uri: string,
  name: string,
  target: string,
  skill: SkillMetadata,
): Promise<string> {
  const skillDirectory = resolve(skill.directory);
  // 技能根自身可能是 symlink（用户级受支持导入形态）：两侧同取 realpath 再比较。
  const realRoot = await realpath(skillDirectory).catch(() => skillDirectory);

  let realTarget: string;
  try {
    realTarget = await realpath(target);
  } catch {
    // ENOENT/EACCES 统一按 not-found 处理（不泄露存在性差异），附资产清单（E9）。
    throw await createNotFoundError(uri, name, skillDirectory);
  }
  if (!isWithinRoot(realRoot, realTarget)) {
    // E8：realpath 逃逸（symlink/junction 指向技能目录外）。
    throw await createSandboxRejectedError("root-escape", name, skill, [
      `Rejected skill:// path: it resolves outside the skill directory (symlink escape): "${uri}".`,
    ]);
  }

  const info = await stat(realTarget).catch(() => undefined);
  if (!info) {
    throw await createNotFoundError(uri, name, skillDirectory);
  }
  if (info.isDirectory()) {
    // E10：目录目标 → 「是目录」+ 该目录一层列表（模型可继续下钻）。
    throw await createDirectoryTargetError(uri, target, name);
  }
  if (!info.isFile()) {
    // E12：socket/fifo 等非常规文件。
    throw skillUriError(
      "skill_uri_invalid_target",
      `skill:// URI must resolve to a file or directory: "${uri}".`,
    );
  }
  return target;
}

// ------------------------------------------------------------
// 错误构造（R4 契约）
// ------------------------------------------------------------

function skillUriError(
  code: string,
  message: string,
  context?: Record<string, unknown>,
): ReturnType<typeof createCoreError> {
  return createCoreError(CoreErrorType.ToolExecutionFailed, message, {
    context: context ? { code, ...context } : { code },
    recoverable: true,
  });
}

/** E6/E7/E8 共用形态：拒绝主体 + 技能根一层资产清单（清单失败不阻断错误主体）。 */
async function createSandboxRejectedError(
  rule: string,
  name: string,
  skill: SkillMetadata,
  body: string[],
): Promise<Error> {
  const listing = await formatAssetListing(skill.directory);
  return skillUriError(
    "skill_uri_sandbox_rejected",
    [...body, listing ? `Assets in skill "${name}": ${listing}` : ""]
      .filter((part) => part.length > 0)
      .join(" "),
    { rule, skillName: name },
  );
}

async function createNotFoundError(
  uri: string,
  name: string,
  skillDirectory: string,
): Promise<Error> {
  const listing = await formatAssetListing(skillDirectory);
  return skillUriError(
    "skill_uri_not_found",
    [`File not found: ${uri}.`, listing ? `Assets in skill "${name}": ${listing}` : ""]
      .filter((part) => part.length > 0)
      .join(" "),
    { skillName: name },
  );
}

async function createDirectoryTargetError(
  uri: string,
  directoryPath: string,
  name: string,
): Promise<Error> {
  const listed = await listDirectoryEntries(directoryPath);
  const listing = listed ? formatListing(listed.names) : "";
  // 示例只挑常规文件条目（isFile），避免把「例如」指向目录或链接。
  const exampleSuffix = listed?.firstFile
    ? ` Read one of its files, e.g. ${uri.endsWith("/") ? uri : `${uri}/`}${listed.firstFile}.`
    : "";
  return skillUriError(
    "skill_uri_is_directory",
    `"${uri}" is a directory, not a file.${listing ? ` Entries: ${listing}.` : ""}${exampleSuffix}`,
    { skillName: name },
  );
}

// ------------------------------------------------------------
// 清单/名单格式化（R4 `<listing>` / E5 `<ids>`）
// ------------------------------------------------------------

interface DirectoryListing {
  /** 显示名（目录带 `/` 后缀），排序 + 上限截断后的产物。 */
  names: string[];
  /** 第一个常规文件条目（示例用）；全为目录/链接时缺席。 */
  firstFile?: string;
}

/** 一层目录清单：排序、上限 100 条；readdir 失败返回 undefined。 */
async function listDirectoryEntries(directoryPath: string): Promise<DirectoryListing | undefined> {
  try {
    const entries = await readdir(resolve(directoryPath), { withFileTypes: true });
    const sorted = entries.slice().sort((left, right) => left.name.localeCompare(right.name));
    const names = sorted.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    const firstFile = sorted.find((entry) => entry.isFile())?.name;
    if (names.length <= MAX_LISTING_ENTRIES) {
      return { names, ...(firstFile ? { firstFile } : {}) };
    }
    return {
      names: [
        ...names.slice(0, MAX_LISTING_ENTRIES),
        `… (+${names.length - MAX_LISTING_ENTRIES} more)`,
      ],
      ...(firstFile ? { firstFile } : {}),
    };
  } catch {
    return undefined;
  }
}

async function formatAssetListing(directoryPath: string): Promise<string | undefined> {
  const listed = await listDirectoryEntries(directoryPath);
  return listed ? formatListing(listed.names) : undefined;
}

function formatListing(entries: readonly string[]): string {
  return entries.join(", ");
}

function formatAvailableIds(skills: readonly SkillMetadata[]): string {
  const ids = new Set<string>();
  for (const skill of skills) {
    ids.add(skill.name);
    if (skill.qualifiedName) ids.add(skill.qualifiedName);
  }
  const sorted = Array.from(ids).sort((left, right) => left.localeCompare(right));
  if (sorted.length === 0) return "none";
  const capped = sorted.slice(0, MAX_AVAILABLE_IDS);
  const overflow = sorted.length - capped.length;
  return overflow > 0 ? `${capped.join(", ")} … (+${overflow} more)` : capped.join(", ");
}
