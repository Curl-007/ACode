// ============================================================
// hook-pins 三态钉扎 · 分类层（specs/plugin-hook-middleware.md 三.5）
// ============================================================
// 从 hook 声明（process/command）静态解析三态 pin。分类绝不抛错：任何异常收敛为
// unpinnable（fail-closed）。一期不做 O_NOFOLLOW 级 TOCTOU 硬化与 PATH 解析（spec R4）。
import { createHash } from "node:crypto";
import { isAbsolute, resolve as resolvePath, sep } from "node:path";
import {
  PINS_INLINE,
  PINS_UNPINNABLE,
  nodeWorkspaceHookPinsFs,
  type WorkspaceHookPin,
  type WorkspaceHookPinsFs,
} from "./workspace-hook-pins.js";

export interface WorkspaceHookPinDeclaration {
  args?: readonly string[];
  command: string;
  type: "command" | "process";
}

const PINS_SHELL_METACHAR_PATTERN = /[|;&<>`\n]|\$\(/u;
const PINS_UNEXPANDED_VARIABLE_PATTERN = /\$\{?[A-Za-z_]/u;
/** 内联代码旗标：代码就在命令文本里（文本即行为）⇒ inline 而非 unpinnable。 */
const PINS_INLINE_CODE_FLAGS = new Set(["-c", "-e", "-p", "--eval", "-"]);
const PINS_INTERPRETER_NAMES = new Set([
  "bash",
  "bun",
  "deno",
  "node",
  "perl",
  "powershell",
  "pwsh",
  "python",
  "python3",
  "ruby",
  "sh",
  "zsh",
]);

/**
 * 三态分类（一期最小，声明驱动）：
 * - process：argv 显式文件引用，永不 inline；验证+哈希成功 ⇒ script，否则 unpinnable。
 * - command：含 shell 元字符 ⇒ inline（复合命令，文本即行为）；剥 `VAR=v`/`env` 前缀后
 *   解析单一调用：路径状首 token、或「裸解释器 + 无旗标 + 路径状脚本实参」⇒ 脚本候选；
 *   内联代码旗标（-c/-e/-p）⇒ inline；旗标面/裸模块名/裸 PATH 程序名 ⇒ unpinnable
 *   （无法静态定位可执行内容——对齐证据：PATH 程序在项目可读根外即不可验证）。
 * - 候选：变量未展开/出项目根/非常规文件/符号链接/硬链接(nlink>1)/fd 与 lstat 不同
 *   inode/读或哈希失败 ⇒ unpinnable；全过 ⇒ script{path=realpath, sha256}。
 * inline 与 unpinnable 的区分即信任粒度边界：inline 是「文本即行为，可等价复核」，
 * unpinnable 是「无法验证，永不等价」。
 */
export async function classifyWorkspaceHookPin(input: {
  declaration: WorkspaceHookPinDeclaration;
  expandVariable?: (text: string) => string;
  fs?: WorkspaceHookPinsFs;
  projectDir: string;
}): Promise<WorkspaceHookPin> {
  const fsImpl = input.fs ?? nodeWorkspaceHookPinsFs;
  try {
    const expanded = expandPinsCommandText(input.declaration.command, input.expandVariable);
    if (expanded === undefined) return PINS_UNPINNABLE;
    if (input.declaration.type === "process") {
      return await pinScriptCandidate(expanded, input.projectDir, fsImpl);
    }
    if (PINS_SHELL_METACHAR_PATTERN.test(expanded)) return PINS_INLINE;
    const stripped = stripPinsEnvPrefixes(tokenizeShellWords(expanded));
    if (!stripped.ok) return PINS_UNPINNABLE;
    if (stripped.tokens.length === 0) return PINS_INLINE;
    const candidate = resolvePinsScriptCandidate(stripped.tokens);
    if (candidate === "inline") return PINS_INLINE;
    if (candidate === "unpinnable") return PINS_UNPINNABLE;
    return await pinScriptCandidate(candidate, input.projectDir, fsImpl);
  } catch {
    return PINS_UNPINNABLE;
  }
}

async function pinScriptCandidate(
  candidate: string,
  projectDir: string,
  fsImpl: WorkspaceHookPinsFs,
): Promise<WorkspaceHookPin> {
  try {
    if (!candidate || PINS_UNEXPANDED_VARIABLE_PATTERN.test(candidate)) return PINS_UNPINNABLE;
    const absolute = isAbsolute(candidate) ? candidate : resolvePath(projectDir, candidate);
    const resolved = await fsImpl.realpath(absolute);
    const root = await fsImpl.realpath(projectDir);
    if (!isPinsPathWithinRoot(resolved, root)) return PINS_UNPINNABLE;
    const stats = await fsImpl.lstat(resolved);
    if (!stats.isFile || stats.isSymbolicLink || stats.nlink !== 1) return PINS_UNPINNABLE;
    const handle = await fsImpl.openRead(resolved);
    try {
      // fd 级 ino/dev 一致：哈希对象与 lstat 对象必须是同一 inode（TOCTOU 收窄）。
      if (handle.ino !== stats.ino || handle.dev !== stats.dev) return PINS_UNPINNABLE;
      const bytes = await handle.readAll();
      return { kind: "script", path: resolved, sha256: sha256Bytes(bytes) };
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    return PINS_UNPINNABLE;
  }
}

function expandPinsCommandText(
  command: string,
  expandVariable?: (text: string) => string,
): string | undefined {
  let text = command;
  if (expandVariable) {
    try {
      text = expandVariable(command);
    } catch {
      return undefined;
    }
  }
  if (PINS_UNEXPANDED_VARIABLE_PATTERN.test(text)) return undefined;
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

type PinsScriptCandidate = string | "inline" | "unpinnable";

function resolvePinsScriptCandidate(tokens: readonly string[]): PinsScriptCandidate {
  const head = tokens[0];
  if (head === undefined) return "inline";
  if (isPinsPathLikeToken(head)) return head;
  if (PINS_INTERPRETER_NAMES.has(head)) {
    const script = tokens[1];
    // 裸解释器无实参：文本即行为。内联代码旗标（-c/-e/-p）：代码就在文本里 ⇒
    // inline。其余旗标面无法可靠定位脚本实参（-r/--require 带值、arity 不可静态
    // 知）⇒ fail-closed；裸模块名（node_modules 解析）静态不可达 ⇒ 同样 fail-closed。
    if (script === undefined) return "inline";
    if (PINS_INLINE_CODE_FLAGS.has(script)) return "inline";
    if (script.startsWith("-")) return "unpinnable";
    if (!isPinsPathLikeToken(script)) return "unpinnable";
    return script;
  }
  // 裸 PATH 程序名：项目可读根之外，内容不可钉。
  return "unpinnable";
}

function stripPinsEnvPrefixes(
  tokens: readonly string[],
): { ok: true; tokens: string[] } | { ok: false } {
  const rest = [...tokens];
  while (rest.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(rest[0] ?? "")) rest.shift();
  if (rest[0] === "env") {
    rest.shift();
    while (rest.length > 0) {
      const head = rest.shift() ?? "";
      if (head === "-u") {
        if (rest.length === 0) return { ok: false };
        rest.shift();
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(head)) continue;
      // -i/-S 等 env 旗标一期不解析 ⇒ 不可验证。
      if (head.startsWith("-")) return { ok: false };
      rest.unshift(head);
      break;
    }
  }
  return { ok: true, tokens: rest };
}

/**
 * 最小 shell 分词：空白切分，尊重单/双引号（元字符已在前置检查排除）。
 * 反斜杠取舍：引号外按**字面路径字符**保留（Windows 路径 `C:\hooks\x.mjs` 是
 * ACode 项目 hook 声明的一等公民，bash 转义语义会让其被吞成 `C:hooksx.mjs`）；
 * 双引号内仅 `\"` 与 `\\` 按转义收敛，其余保留字面。需要空格的 bash 实参用引号。
 */
export function tokenizeShellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quoting: "double" | "single" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quoting === "single") {
      if (char === "'") quoting = undefined;
      else current += char;
      continue;
    }
    if (quoting === "double") {
      if (char === "\\" && (command[index + 1] === '"' || command[index + 1] === "\\")) {
        current += command[index + 1];
        index += 1;
        continue;
      }
      if (char === '"') {
        quoting = undefined;
        continue;
      }
      current += char;
      continue;
    }
    if (char === "'") {
      quoting = "single";
      continue;
    }
    if (char === '"') {
      quoting = "double";
      continue;
    }
    if (/\s/u.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}

function isPinsPathLikeToken(token: string): boolean {
  return token.includes("/") || token.includes("\\") || token.startsWith(".");
}

function isPinsPathWithinRoot(path: string, root: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return path.startsWith(prefix) && path.length > prefix.length;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
