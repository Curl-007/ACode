// Mechanism ported from oh-my-pi (MIT) crates/pi-walker — 语义参照，Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// gitignore 遍历规则链（specs/fs-hotpath-mechanisms.md R2）
//
// 用 `ignore` npm 包实现 .gitignore/.ignore 语义（negation、目录规则、** 通配、
// 锚定前缀）。规则集按目录层级构建并缓存，跨请求复用；以规则文件的
// mtime+size 戳复验，变更（含删除）即重建。
//
// gitignore 层级语义：更深的 .gitignore 覆盖更浅的；沿 root→目标的祖先链逐层
// test，最后一个「明确匹配」（ignored 或 unignored）胜出——与 git check-ignore
// 的最深匹配规则一致。
// ============================================================

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import ignore from "ignore";
import type { Ignore } from "ignore";

const GITIGNORE_FILENAMES = [".gitignore", ".ignore"] as const;
/** 固定兜底：无 .gitignore 的目录也默认排除 node_modules（优先级最低，可被 !node_modules 恢复）。 */
const NODE_MODULES_FALLBACK_PATTERN = "node_modules/";

interface CachedRules {
  /** 规则文件戳：任一文件缺失/变更都会改变戳值，触发重建。 */
  stamp: string;
  rules: Ignore | null;
}

export class GitignoreRuleStore {
  private readonly cache = new Map<string, CachedRules>();

  /** 目录规则实例（仅该目录自己的 .gitignore/.ignore）；无任何规则文件时为 null。 */
  async rulesFor(dirAbsPath: string, includeNodeModulesFallback: boolean): Promise<Ignore | null> {
    const cached = this.cache.get(dirAbsPath);
    const stamp = await readRuleFilesStamp(dirAbsPath);
    if (cached && cached.stamp === stamp) return cached.rules;

    const rules = await loadRules(dirAbsPath, includeNodeModulesFallback);
    this.cache.set(dirAbsPath, { stamp, rules });
    return rules;
  }

  clear(): void {
    this.cache.clear();
  }
}

// 进程级共享：规则文件很少变，mtime 戳复验足够安全。
const sharedRuleStore = new GitignoreRuleStore();

/**
 * 单次扫描的匹配器。root 固定；isIgnored 沿祖先链做最深匹配裁决。
 * includeNodeModulesFallback=false 时（no-ignore 逃生口）不注入兜底规则。
 */
export class GitignoreWalker {
  constructor(
    private readonly root: string,
    private readonly includeNodeModulesFallback: boolean,
  ) {}

  /**
   * relPath：posix 相对路径（如 "src/a.ts" 或目录 "build"）。
   * isDirectory：目标是目录时为 true——目录 test 以尾斜杠下发，才能命中
   * `build/` 型仅目录规则（gitignore 目录语义）。
   */
  async isIgnored(relPath: string, isDirectory: boolean): Promise<boolean> {
    const segments = relPath.split("/");
    if (segments.length === 0 || segments.some((segment) => segment.length === 0)) return false;

    // 沿 root→目标祖先链逐层 test；最后一个明确匹配胜出（deeper overrides）。
    // 中间段必为目录；末段按 isDirectory 决定是否补尾斜杠。
    let decisive: boolean | undefined;
    let dirAbsPath = this.root;
    for (let depth = 0; depth < segments.length; depth += 1) {
      const rules = await sharedRuleStore.rulesFor(dirAbsPath, this.includeNodeModulesFallback);
      if (rules) {
        const isFinalSegment = depth === segments.length - 1;
        const testAsDirectory = isFinalSegment ? isDirectory : true;
        const rawRelative = segments.slice(depth).join("/");
        const relativeFromDir = testAsDirectory ? `${rawRelative}/` : rawRelative;
        const outcome = rules.test(relativeFromDir);
        if (outcome.ignored) decisive = true;
        else if (outcome.unignored) decisive = false;
      }
      dirAbsPath = join(dirAbsPath, segments[depth] ?? "");
    }
    return decisive ?? false;
  }
}

async function loadRules(
  dirAbsPath: string,
  includeNodeModulesFallback: boolean,
): Promise<Ignore | null> {
  const instance = ignore();
  let hasAny = false;
  if (includeNodeModulesFallback) {
    // 兜底规则先加 = 优先级最低；用户 .gitignore 里的 !node_modules/ 仍可恢复。
    instance.add(NODE_MODULES_FALLBACK_PATTERN);
    hasAny = true;
  }
  for (const filename of GITIGNORE_FILENAMES) {
    // 后加载者优先：.ignore 覆盖 .gitignore（与 ripgrep/ignore crate 顺序一致）。
    const patterns = await readRuleFileLines(join(dirAbsPath, filename));
    if (patterns.length > 0) {
      instance.add(patterns);
      hasAny = true;
    }
  }
  return hasAny ? instance : null;
}

async function readRuleFileLines(filePath: string): Promise<string[]> {
  try {
    const content = await readFile(filePath, "utf8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch {
    return [];
  }
}

async function readRuleFilesStamp(dirAbsPath: string): Promise<string> {
  const parts: string[] = [];
  for (const filename of GITIGNORE_FILENAMES) {
    try {
      const info = await stat(join(dirAbsPath, filename));
      parts.push(`${Math.trunc(info.mtimeMs)}:${info.size}`);
    } catch {
      parts.push("missing");
    }
  }
  return parts.join("|");
}
