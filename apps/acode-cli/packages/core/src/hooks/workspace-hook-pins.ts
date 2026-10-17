// ============================================================
// hook-pins 三态钉扎 · 记录层（specs/plugin-hook-middleware.md 三）
// ============================================================
// 每项目一份 pins 记录：hookDeclarationDigest(64hex) → 三态 pin。回答「声明在授予时
// 解析到了什么、内容是否可钉」，与 trust 记录（bundleDigest 谱系，
// workspace-hook-trust-records.ts）同属授予事实记录层。
//
// 单源义务：CLI 树（core/src/hooks）是执行面与本 store 的唯一写入方；波 1 services
// 侧 workspaceHookValueHash.ts 是 trust 记录的展示值哈希投影，不得读写 pins 文件、
// 不得重算 pin 分类。一期只落记录层 API；admission/review 复核接线登记 W3。
//
// 拆分说明：pins 面最初落在 workspace-hook-trust-records.ts 内，越过 400 行
// max-lines ratchet 后按仓库先例（runtime/methods/hooks.ts → hooks-extended.ts）
// 拆为「记录层（本文件）+ 分类层（workspace-hook-pins-classify.ts）」，经
// workspace-hook-trust-domain.ts barrel 再导出，公开导入路径不变。
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const WORKSPACE_HOOK_PINS_VERSION = 1;

/** 三态 pin：script=路径+内容哈希已钉；inline=文本即行为（digest 已钉文本）；unpinnable=无法验证（fail-closed）。 */
export type WorkspaceHookPin =
  | { kind: "script"; path: string; sha256: string }
  | { kind: "inline" }
  | { kind: "unpinnable" };

export const PINS_HEX64_PATTERN = /^[0-9a-f]{64}$/u;
export const PINS_INLINE: WorkspaceHookPin = Object.freeze({ kind: "inline" });
export const PINS_UNPINNABLE: WorkspaceHookPin = Object.freeze({ kind: "unpinnable" });

/** 可注入 fs 面：测试全内存驱动；默认 node:fs/promises 薄封装。 */
export interface WorkspaceHookPinsFs {
  lstat(
    path: string,
  ): Promise<{ dev: number; ino: number; isFile: boolean; isSymbolicLink: boolean; nlink: number }>;
  mkdir(path: string, options: { mode?: number; recursive: true }): Promise<void>;
  openRead(
    path: string,
  ): Promise<{ close(): Promise<void>; dev: number; ino: number; readAll(): Promise<Uint8Array> }>;
  readFileText(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  writeFileText(path: string, text: string, options: { mode: number }): Promise<void>;
}

export const nodeWorkspaceHookPinsFs: WorkspaceHookPinsFs = {
  async lstat(path) {
    const stats = await lstat(path);
    return {
      dev: Number(stats.dev),
      ino: Number(stats.ino),
      isFile: stats.isFile(),
      isSymbolicLink: stats.isSymbolicLink(),
      nlink: stats.nlink,
    };
  },
  async mkdir(path, options) {
    await mkdir(path, options);
  },
  async openRead(path) {
    const handle = await open(path, "r");
    try {
      const stats = await handle.stat();
      return {
        dev: Number(stats.dev),
        ino: Number(stats.ino),
        readAll: () => handle.readFile(),
        close: () => handle.close(),
      };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  },
  readFileText: (path) => readFile(path, "utf8"),
  realpath: (path) => realpath(path),
  rename: (from, to) => rename(from, to),
  async writeFileText(path, text, options) {
    await writeFile(path, text, { encoding: "utf8", mode: options.mode });
  },
};

/** 文件名对齐证据形态：`hook-pins-<sha256(projectKey)前32hex>.jsonl`（内容为单个 JSON 文档）。 */
export function workspaceHookPinsFileName(projectKey: string): string {
  return `hook-pins-${sha256Text(projectKey).slice(0, 32)}.jsonl`;
}

/** pins 目录约定（dataRootDir 由装配层给；与 ambient 的 `<dataRoot>/cli/...` 同构）。 */
export function workspaceHookPinsDirPath(dataRootDir: string): string {
  return join(dataRootDir, "cli", "hook-pins");
}

export type WorkspaceHookPinsReadStatus = "missing" | "ok" | "invalid";

export interface WorkspaceHookPinsReadResult {
  /** missing=首次授予前无记录（非错误）；invalid=损坏/schema 不符/project 不匹配/读错误（一律空集，fail-closed）。 */
  status: WorkspaceHookPinsReadStatus;
  pins: Map<string, WorkspaceHookPin>;
}

/** 读时校验 + project 不匹配即空集（fail-closed）。 */
export async function readWorkspaceHookPins(input: {
  fs?: WorkspaceHookPinsFs;
  pinsDir: string;
  projectKey: string;
}): Promise<WorkspaceHookPinsReadResult> {
  const fsImpl = input.fs ?? nodeWorkspaceHookPinsFs;
  const filePath = join(input.pinsDir, workspaceHookPinsFileName(input.projectKey));
  let raw: string;
  try {
    raw = await fsImpl.readFileText(filePath);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { status: "missing", pins: new Map() };
    return { status: "invalid", pins: new Map() };
  }
  return parseWorkspaceHookPinsDocument(raw, input.projectKey);
}

/** 手写形状校验（core 无 zod 依赖；先例：services hooksService 的手写局部校验）。任何偏差 ⇒ invalid。 */
export function parseWorkspaceHookPinsDocument(
  raw: string,
  projectKey: string,
): WorkspaceHookPinsReadResult {
  const invalid: WorkspaceHookPinsReadResult = { status: "invalid", pins: new Map() };
  let document: unknown;
  try {
    document = JSON.parse(raw.trim());
  } catch {
    return invalid;
  }
  if (!isPlainRecord(document)) return invalid;
  if (document.version !== WORKSPACE_HOOK_PINS_VERSION) return invalid;
  // project 不匹配 ⇒ 空集：文件被挪用/复制到其他项目不得继承任何钉扎。
  if (document.project !== projectKey) return invalid;
  if (!isPlainRecord(document.pins)) return invalid;
  const pins = new Map<string, WorkspaceHookPin>();
  for (const [digest, value] of Object.entries(document.pins)) {
    if (!PINS_HEX64_PATTERN.test(digest)) return invalid;
    const pin = parseWorkspaceHookPin(value);
    if (!pin) return invalid;
    pins.set(digest, pin);
  }
  return { status: "ok", pins };
}

/**
 * 原子写：mkdir(0o700) + 唯一名临时文件（pid-uuid8 段防并发写面互抢）+ rename
 * （0o600）。Windows 上 rename 覆盖会被杀软/索引器短暂句柄锁打断（EPERM/EBUSY/
 * ENOENT）——有限重试 + 退避，重试期间旧文件保持完整（core/src/ambient/queue.ts
 * F3 同款模式）。写前校验：非法 digest/pin 形状直接抛错，绝不落盘半合法记录。
 */
export async function writeWorkspaceHookPins(input: {
  fs?: WorkspaceHookPinsFs;
  pins: ReadonlyMap<string, WorkspaceHookPin>;
  pinsDir: string;
  projectKey: string;
}): Promise<void> {
  const fsImpl = input.fs ?? nodeWorkspaceHookPinsFs;
  const pinsRecord: Record<string, WorkspaceHookPin> = {};
  const sorted = [...input.pins.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [digest, pin] of sorted) {
    if (!PINS_HEX64_PATTERN.test(digest) || !parseWorkspaceHookPin(pin)) {
      throw new Error(`Invalid workspace hook pin entry for digest: ${digest}`);
    }
    pinsRecord[digest] = pin;
  }
  const filePath = join(input.pinsDir, workspaceHookPinsFileName(input.projectKey));
  await fsImpl.mkdir(input.pinsDir, { recursive: true, mode: 0o700 });
  const payload = `${JSON.stringify({
    version: WORKSPACE_HOOK_PINS_VERSION,
    project: input.projectKey,
    pins: pinsRecord,
  })}\n`;
  const tmpPath = `${filePath}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`;
  await fsImpl.writeFileText(tmpPath, payload, { mode: 0o600 });
  const RETRY_DELAYS_MS = [15, 50, 120];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsImpl.rename(tmpPath, filePath);
      return;
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransientRenameError(error)) throw error;
      if (errnoCode(error) === "ENOENT") {
        await fsImpl.writeFileText(tmpPath, payload, { mode: 0o600 });
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * 等价判定（复核「授予时至今是否漂移」）：inline≡inline；script≡script 且 sha256
 * 与 path 相同（存储 path 已是 realpath 规范值）；**unpinnable 与任何 pin（含
 * unpinnable）都不等价**——未知态永远触发重新核验，这是三态的 fail-closed 核心。
 */
export function workspaceHookPinEquals(
  a: WorkspaceHookPin | undefined,
  b: WorkspaceHookPin | undefined,
): boolean {
  if (!a || !b) return false;
  if (a.kind === "inline" && b.kind === "inline") return true;
  if (a.kind === "script" && b.kind === "script") {
    return a.sha256 === b.sha256 && a.path === b.path;
  }
  return false;
}

/** 展示投影：script→sha256 前 12 hex；inline→"inline"；unpinnable→"unknown"；缺席→"none"。 */
export function describeWorkspaceHookPin(pin: WorkspaceHookPin | undefined): string {
  if (!pin) return "none";
  switch (pin.kind) {
    case "script":
      return pin.sha256.slice(0, 12);
    case "inline":
      return "inline";
    case "unpinnable":
      return "unknown";
  }
}

export function parseWorkspaceHookPin(value: unknown): WorkspaceHookPin | undefined {
  if (!isPlainRecord(value)) return undefined;
  const keys = Object.keys(value);
  switch (value.kind) {
    case "script": {
      if (keys.length !== 3) return undefined;
      if (typeof value.path !== "string" || value.path.length === 0) return undefined;
      if (typeof value.sha256 !== "string" || !PINS_HEX64_PATTERN.test(value.sha256)) {
        return undefined;
      }
      return { kind: "script", path: value.path, sha256: value.sha256 };
    }
    case "inline":
      return keys.length === 1 ? PINS_INLINE : undefined;
    case "unpinnable":
      return keys.length === 1 ? PINS_UNPINNABLE : undefined;
    default:
      return undefined;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isTransientRenameError(error: unknown): boolean {
  const code = errnoCode(error);
  return code === "EPERM" || code === "EBUSY" || code === "ENOENT";
}
