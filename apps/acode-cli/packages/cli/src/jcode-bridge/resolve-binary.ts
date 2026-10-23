// ============================================================
// jcode 桥接：二进制路径解析（specs/jcode-agent-bridge.md R7 +
// packages/shared/specs/agent-engine-jcode-slot.md R5）
//
// 纯逻辑，无外部 I/O：env 读取与 PATH 探测都由调用方（entry.ts，I/O 边界）注入。
// 这样解析规则可单测，且不违反根 AGENTS.md「外部 I/O 收敛」——本模块不碰 fs/child_process/process.env。
//
// 优先级 = `--jcode-binary` CLI 参数 → `ACODE_JCODE_BINARY_PATH` env → PATH 上的 jcode。
//
// 为什么这里破例接受一个 ACODE_* env（apps/acode-cli/AGENTS.md 默认要求「能用 CLI 参数
// 表达的优先不做成 env」）：**打包态桌面没有别的通道**。桌面是 GUI 应用，继承的 PATH 不含
// login shell profile 的条目（~/.local/bin、Homebrew 路径），而 runtimeLoginShellEnvCapture
// 采集的 PATH 补丁只注入工具执行 env、不注入 agent spawn env——所以 PATH 查找在打包桌面里
// 不可靠。同时 `ACODE_AGENT_SERVER_ARGS_JSON` 那条能带 CLI 参数的通道在打包态被
// agent-command-env-gate.md R1 禁用。剩下唯一符合 R3「走 Settings 显式配置（用户可见动作）」
// 的路径就是：Settings.jcodeBinaryPath → Host resolveSpawnEnv → 本 env。
//
// 安全纪律（strip-then-inject，同 NODE_OPTIONS）：该 env 在 runtimeEnv.ts 的
// SANITIZED_RUNTIME_ENV_KEYS 里，继承的用户级值一律被剔除，只有 Host 装配后注入的值存活。
// 故用户级 env 注入无法把 jcode 指向攻击者二进制。
// ============================================================

import { ACODE_JCODE_BINARY_PATH_ENV_KEY } from "@acode/shared";

/** PATH 查找探针：返回可执行文件绝对路径，找不到返回 null。由 entry.ts 注入实现。 */
export type WhichFn = (name: string) => string | null;

/** jcode 可执行文件名（不含扩展名）。 */
const JCODE_BIN_NAME = "jcode";
/** Windows 上 spawn 需要显式 .exe（Node spawn 不像 shell 会自动补 PATHEXT）。 */
const JCODE_BIN_NAME_WINDOWS = "jcode.exe";

/**
 * 解析 jcode 二进制路径。
 *
 * 优先级（spec R5）：`--jcode-binary` CLI 参数 > `ACODE_JCODE_BINARY_PATH` env（Host 从
 * Settings.jcodeBinaryPath 装配注入）> PATH 查找。三者皆无即抛错，调用方让进程以明确
 * 错误退出（不发半死 storage 帧）。
 *
 * @param explicit  CLI `--jcode-binary` 的显式路径（可空）。给了就原样返回——
 *                  存在性交给 spawn 时的 ENOENT 报错，此处不做 fs 探测（I/O 收敛）。
 * @param envValue  `ACODE_JCODE_BINARY_PATH` 的值（由 entry.ts 读 process.env 后传入，
 *                  本模块保持纯函数）。打包态桌面靠它：GUI 的 PATH 不含 login shell 条目。
 * @param platform  process.platform，决定 PATH 查找用 jcode 还是 jcode.exe。
 * @param which     PATH 探针（entry.ts 注入）。
 * @throws 三条路径都落空时抛错。
 */
export function resolveJcodeBinary(
  explicit: string | undefined,
  envValue: string | undefined,
  platform: NodeJS.Platform | string,
  which: WhichFn,
): string {
  const fromCli = explicit?.trim();
  if (fromCli && fromCli.length > 0) {
    return fromCli;
  }
  const fromEnv = envValue?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  const candidates =
    platform === "win32" ? [JCODE_BIN_NAME_WINDOWS, JCODE_BIN_NAME] : [JCODE_BIN_NAME];
  for (const name of candidates) {
    const found = which(name);
    if (found) return found;
  }
  throw new Error(
    `jcode binary not found (looked for: --jcode-binary, ${ACODE_JCODE_BINARY_PATH_ENV_KEY}, ` +
      `PATH ${candidates.join(", ")}). Install jcode and ensure it is on PATH, ` +
      `set ${ACODE_JCODE_BINARY_PATH_ENV_KEY}, or pass --jcode-binary <path>.`,
  );
}
