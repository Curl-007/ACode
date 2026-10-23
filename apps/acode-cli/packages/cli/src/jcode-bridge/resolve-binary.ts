// ============================================================
// jcode 桥接：二进制路径解析（specs/jcode-agent-bridge.md R7 +
// packages/shared/specs/agent-engine-jcode-slot.md R5）
//
// 纯逻辑，无外部 I/O：env 读取、PATH 探测与候选路径存在性探测都由调用方
// （entry.ts，I/O 边界）注入。这样解析规则可单测，且不违反根 AGENTS.md
// 「外部 I/O 收敛」——本模块不碰 fs/child_process/process.env。
//
// 优先级 = `--jcode-binary` CLI 参数 → `ACODE_JCODE_BINARY_PATH` env（Settings 的
// 显式覆盖项）→ **常见安装位置**（jcode 官方安装脚本的默认落点）→ PATH 上的 jcode。
//
// 为什么需要「常见安装位置」这一层：jcode 安装脚本（install.ps1:5 / install.sh:148）
// 默认装到 %LOCALAPPDATA%\jcode\bin（Windows）或 $HOME/.local/bin（Unix），并把该目录
// 写进 shell rc 的 PATH 行——而桌面是 GUI 应用，继承的 PATH **不含** rc 条目，
// PATH 查找在打包桌面里不可靠，故按安装脚本的默认落点直接探测。
//
// 为什么这里破例接受一个 ACODE_* env（apps/acode-cli/AGENTS.md 默认要求「能用 CLI 参数
// 表达的优先不做成 env」）：**打包态桌面需要一条用户可见的覆盖通道**。Settings.
// jcodeBinaryPath 现在是**可选覆盖项**（自动发现落空或装在非默认位置时手填），经
// Host resolveSpawnEnv → 本 env 传入；`ACODE_AGENT_SERVER_ARGS_JSON` 那条能带 CLI
// 参数的通道在打包态被 agent-command-env-gate.md R1 禁用。
//
// 安全纪律（strip-then-inject，同 NODE_OPTIONS）：该 env 在 runtimeEnv.ts 的
// SANITIZED_RUNTIME_ENV_KEYS 里，继承的用户级值一律被剔除，只有 Host 装配后注入的值存活。
// 故用户级 env 注入无法把 jcode 指向攻击者二进制。
// ============================================================

import { join } from "node:path";
import { ACODE_JCODE_BINARY_PATH_ENV_KEY } from "@acode/shared";

/** PATH 查找探针：返回可执行文件绝对路径，找不到返回 null。由 entry.ts 注入实现。 */
export type WhichFn = (name: string) => string | null;

/**
 * 候选路径存在性探针（异步，I/O 在调用方）：返回该路径是否为可用文件。
 * 由 entry.ts 用 fs/promises 的 access 注入；本模块保持纯函数。
 */
export type PathProbe = (candidate: string) => Promise<boolean>;

/** jcode 可执行文件名（不含扩展名）。 */
const JCODE_BIN_NAME = "jcode";
/** Windows 上 spawn 需要显式 .exe（Node spawn 不像 shell 会自动补 PATHEXT）。 */
const JCODE_BIN_NAME_WINDOWS = "jcode.exe";
/** jcode 官方安装脚本的默认安装子目录（install.ps1:5 / install.sh:148）。 */
const JCODE_WINDOWS_INSTALL_SUBDIR = join("jcode", "bin");
const JCODE_UNIX_INSTALL_SUBDIR = join(".local", "bin");
/** Unix 手动安装/软链的常见位置（install.sh 的 JCODE_INSTALL_DIR 之外的惯例落点）。 */
const JCODE_UNIX_FALLBACK_DIRS = ["/usr/local/bin"];

/**
 * jcode 官方安装脚本的默认落点候选（按平台）。只拼路径、不碰 fs（纯函数）。
 *
 * 证据：jcode scripts/install.ps1:5「installs it to %LOCALAPPDATA%\jcode\bin」、
 * scripts/install.sh:146-148（win 分支 $LOCALAPPDATA/jcode/bin；其余 $HOME/.local/bin）。
 * 环境变量缺失（LOCALAPPDATA / HOME 未设）时对应候选缺席，不拼出空根路径。
 *
 * @param platform process.platform。
 * @param env      进程 env 的只读视图（entry.ts 注入 process.env），只读 LOCALAPPDATA / HOME。
 */
export function jcodeWellKnownCandidates(
  platform: NodeJS.Platform | string,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    return localAppData
      ? [join(localAppData, JCODE_WINDOWS_INSTALL_SUBDIR, JCODE_BIN_NAME_WINDOWS)]
      : [];
  }
  const home = env.HOME?.trim();
  const candidates = home ? [join(home, JCODE_UNIX_INSTALL_SUBDIR, JCODE_BIN_NAME)] : [];
  for (const dir of JCODE_UNIX_FALLBACK_DIRS) {
    candidates.push(join(dir, JCODE_BIN_NAME));
  }
  return candidates;
}

/**
 * 解析 jcode 二进制路径。
 *
 * 优先级（spec R5）：`--jcode-binary` CLI 参数 > `ACODE_JCODE_BINARY_PATH` env（Host 从
 * Settings.jcodeBinaryPath 装配注入，**可选覆盖项**）> 常见安装位置（probe 探测）>
 * PATH 查找。四者皆无即抛错，调用方让进程以明确错误退出（不发半死 storage 帧）。
 *
 * @param explicit    CLI `--jcode-binary` 的显式路径（可空）。给了就原样返回——
 *                    存在性交给 spawn 时的 ENOENT 报错，此处不做 fs 探测（I/O 收敛）。
 * @param envValue    `ACODE_JCODE_BINARY_PATH` 的值（由 entry.ts 读 process.env 后传入，
 *                    本模块保持纯函数）。Settings 覆盖项的通道。
 * @param platform    process.platform，决定 PATH 查找与候选文件名（jcode / jcode.exe）。
 * @param which       PATH 探针（entry.ts 注入）。
 * @param probe       候选路径存在性探针（entry.ts 注入 fs access）。缺席 ⇒ 跳过常见安装
 *                    位置一层（旧调用方形态，行为退化为 CLI > env > PATH）。
 * @param wellKnown   常见安装位置候选（entry.ts 用 jcodeWellKnownCandidates 拼好传入）。
 * @throws 四条路径都落空时抛错（错误文案列出全部查找位置）。
 */
export async function resolveJcodeBinary(
  explicit: string | undefined,
  envValue: string | undefined,
  platform: NodeJS.Platform | string,
  which: WhichFn,
  probe?: PathProbe,
  wellKnown?: readonly string[],
): Promise<string> {
  const fromCli = explicit?.trim();
  if (fromCli && fromCli.length > 0) {
    return fromCli;
  }
  const fromEnv = envValue?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  // 常见安装位置优先于 PATH：桌面 GUI 的 PATH 不含安装脚本写进 rc 的条目，
  // 而默认落点是安装脚本的确定性输出，探测成本只是一次 access。
  if (probe && wellKnown) {
    for (const candidate of wellKnown) {
      if (await probe(candidate)) return candidate;
    }
  }
  const candidates =
    platform === "win32" ? [JCODE_BIN_NAME_WINDOWS, JCODE_BIN_NAME] : [JCODE_BIN_NAME];
  for (const name of candidates) {
    const found = which(name);
    if (found) return found;
  }
  const lookedAt = [
    "--jcode-binary",
    ACODE_JCODE_BINARY_PATH_ENV_KEY,
    ...(wellKnown ?? []),
    `PATH ${candidates.join(", ")}`,
  ];
  throw new Error(
    `jcode binary not found (looked for: ${lookedAt.join(", ")}). Install jcode ` +
      `(default locations are probed automatically), ensure it is on PATH, set the ` +
      `jcode binary path in ACode Settings, or pass --jcode-binary <path>.`,
  );
}
