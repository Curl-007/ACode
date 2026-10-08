import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * 服务层路径收口助手。
 *
 * 背景：commands/subagents/feedback 等文件操作服务经 ProxyChannel 全量暴露给
 * renderer/远程客户端，rpc 层不做参数 schema 校验，路径参数是裸 string——服务层
 * 是路径收口的唯一所有者（confused deputy 防护）。
 * spec: packages/services/specs/service-fs-path-confinement.md
 *
 * 判定纪律与 skillsService.deleteSkill 的受控根白名单一致：两侧 realpath 规范化后
 * 用 relative 比较，系统软链别名（macOS /tmp→/private/tmp 等）在两侧抵消不误判，
 * 而"经受控根内软链祖先逃逸到根外"的目标会被展开到真实位置后拒绝。
 */

export type ConfinedPathStatus = "inside" | "absent" | "outside";

export interface ConfinePathParams {
  /** 待校验的原始路径（RPC 裸 string），无需预规范化。 */
  target: string;
  /** 受控根集合：目标必须严格位于（不等于）其中某个根之内。 */
  roots: readonly string[];
  /**
   * 结构兜底：当 RPC 参数无法解析出真实受控根时（如删除参数不携带 workspacePath），
   * 允许目标位于任意一个以给定段序列结尾的目录（如 [".acode","commands"]）严格之内。
   * 只用于把可操作面收敛到"该域文件"，不能替代可解析根的真实收口。
   */
  fallbackDirectorySegments?: readonly (readonly string[])[];
}

export interface ConfinePathResult {
  status: ConfinedPathStatus;
  /**
   * 后续 fs 操作应使用的路径：inside 为 realpath 规范化结果，absent 为词法解析结果。
   * outside 时调用方必须拒绝操作，不得消费该字段。
   */
  path: string;
}

/** Windows/macOS 默认文件系统大小写不敏感；目录段比较与文件系统语义保持一致，避免误拒。 */
function segmentEquals(left: string, right: string): boolean {
  if (process.platform === "win32" || process.platform === "darwin") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

/** 严格在内：relative 非空、不以 ".." 开头、不是绝对路径（跨盘符时 relative 返回绝对路径）。 */
function isStrictlyInside(rootPath: string, targetPath: string): boolean {
  const relativePath = relative(rootPath, targetPath);
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

/**
 * 目标的祖先链中是否存在以给定段序列结尾的受控目录（如 <…>/.acode/commands），
 * 且目标严格位于该目录之下。从 dirname(target) 起走，天然排除"目标等于受控目录自身"。
 */
function matchesDirectoryShape(
  targetPath: string,
  segmentSets: readonly (readonly string[])[],
): boolean {
  for (const segments of segmentSets) {
    if (segments.length === 0) continue;
    let current = dirname(targetPath);
    for (;;) {
      let cursor = current;
      let matched = true;
      for (let index = segments.length - 1; index >= 0; index -= 1) {
        if (!segmentEquals(basename(cursor), segments[index]!)) {
          matched = false;
          break;
        }
        cursor = dirname(cursor);
      }
      if (matched) return true;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return false;
}

/**
 * 三态收口判定：
 * - inside：目标存在且规范化后严格位于某受控根内（或命中结构兜底）；
 * - absent：目标不存在但词法解析后位于受控根内（调用方按幂等 no-op 处理）；
 * - outside：越界（含词法在内但 realpath 逃逸的软链穿越），调用方必须拒绝。
 */
export async function confinePath(params: ConfinePathParams): Promise<ConfinePathResult> {
  const rawTarget = params.target?.trim() ?? "";
  if (!rawTarget) {
    return { status: "outside", path: "" };
  }
  const resolvedTarget = resolve(rawTarget);
  const canonicalTarget = await realpath(resolvedTarget).catch(() => null);
  const effectiveTarget = canonicalTarget ?? resolvedTarget;

  for (const rawRoot of params.roots) {
    const trimmedRoot = rawRoot?.trim() ?? "";
    if (!trimmedRoot) continue;
    const resolvedRoot = resolve(trimmedRoot);
    if (canonicalTarget) {
      // 目标存在：两侧都规范化后比较。根 realpath 失败（根尚不存在）时退化为词法根，
      // 此时存在的目标不可能真实位于缺失的根内，比较自然失败。
      const canonicalRoot = await realpath(resolvedRoot).catch(() => resolvedRoot);
      if (isStrictlyInside(canonicalRoot, canonicalTarget)) {
        return { status: "inside", path: canonicalTarget };
      }
    } else if (isStrictlyInside(resolvedRoot, resolvedTarget)) {
      return { status: "absent", path: resolvedTarget };
    }
  }

  const segmentSets = params.fallbackDirectorySegments;
  if (
    segmentSets &&
    segmentSets.length > 0 &&
    matchesDirectoryShape(effectiveTarget, segmentSets)
  ) {
    return { status: canonicalTarget ? "inside" : "absent", path: effectiveTarget };
  }

  return { status: "outside", path: effectiveTarget };
}
