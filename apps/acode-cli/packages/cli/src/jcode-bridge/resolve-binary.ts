// ============================================================
// jcode 桥接：二进制路径解析（spec R7）
//
// 纯逻辑，无外部 I/O：PATH 探测由调用方（entry.ts，I/O 边界）注入 which 函数。
// 这样解析规则可单测，且不违反根 AGENTS.md「外部 I/O 收敛」——本模块不碰 fs/child_process。
//
// R7 裁决：优先级 = 显式 CLI 参数 → PATH 上的 jcode（Windows 追加 .exe）。
// **不新增 ACODE_* 环境变量**（apps/acode-cli/AGENTS.md：能用 CLI 参数表达的优先不做成 env）。
// ============================================================

/** PATH 查找探针：返回可执行文件绝对路径，找不到返回 null。由 entry.ts 注入实现。 */
export type WhichFn = (name: string) => string | null;

/** jcode 可执行文件名（不含扩展名）。 */
const JCODE_BIN_NAME = "jcode";
/** Windows 上 spawn 需要显式 .exe（Node spawn 不像 shell 会自动补 PATHEXT）。 */
const JCODE_BIN_NAME_WINDOWS = "jcode.exe";

/**
 * 解析 jcode 二进制路径。
 *
 * @param explicit  CLI `--jcode-binary` 的显式路径（可空）。给了就原样返回——
 *                  存在性交给 spawn 时的 ENOENT 报错，此处不做 fs 探测（I/O 收敛）。
 * @param platform  process.platform，决定 PATH 查找用 jcode 还是 jcode.exe。
 * @param which     PATH 探针（entry.ts 注入）。
 * @throws 显式路径为空且 PATH 上找不到 jcode 时抛错——调用方据此让进程以明确错误退出，
 *         不发半死 storage 帧（spec R7）。
 */
export function resolveJcodeBinary(
  explicit: string | undefined,
  platform: NodeJS.Platform | string,
  which: WhichFn,
): string {
  const trimmed = explicit?.trim();
  if (trimmed && trimmed.length > 0) {
    return trimmed;
  }
  const candidates =
    platform === "win32" ? [JCODE_BIN_NAME_WINDOWS, JCODE_BIN_NAME] : [JCODE_BIN_NAME];
  for (const name of candidates) {
    const found = which(name);
    if (found) return found;
  }
  throw new Error(
    `jcode binary not found on PATH (looked for: ${candidates.join(", ")}). ` +
      `Install jcode and ensure it is on PATH, or pass --jcode-binary <path>.`,
  );
}
