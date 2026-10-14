/**
 * 真机烟测入口（specs/windows-helper-producer.md §15 契约；A3 交付层级 = --capture/
 * --uia/--host，--pointer 人工 C07 专属）。仓库侧 dev/验收工具，不是 Helper 运行时面
 * ——§1.1 解析隔离只约束 dist/windows-helper.js 进程；本脚本允许经 tsx 深导入
 * workspace TS（§15.1）。
 *
 * 文件组织（A3 实现批次拆分，max-lines 治理，§19 第 15 条）：本入口承载运行命令面、
 * 输出纪律（§15.3 的单一落点：emit/自证泄漏扫描/退出码）、前置检查与主流程；层级实现
 * 在 smoke-levels.mjs（ctx 注入输出原语），共享机械件在 smoke-lib.mjs。
 *
 * 运行命令（仓库根执行，钉死）：
 *   node --import tsx cua-producer/scripts/smoke-real.mjs <flags>
 *   flags: --capture --uia --host --pointer（前三个可组合；--pointer 必须单独出现，
 *   与任何其它 flag 组合 → exit 2）；无 flag/未知 flag → usage + exit 2。
 *
 * 门禁层级（§15.1）：--capture/--uia/--host = 真机门禁可执行层级（ubuntu CI 永不执行：
 * 非 win32 前置即 exit 2）；--pointer = 仅供人工 C07，门禁永不执行——双保险 = flag 之外
 * 还须 ACODE_CUA_SMOKE_POINTER_LIVE=1，缺一 → exit 2。
 *
 * 退出码（§15.3 封闭）：0 = 所选层级全部断言通过；1 = 断言/契约失败（含输出纪律自证
 * 失败）；2 = 前置失败（非 win32、工件缺失、addon 加载被拒、非交互桌面/锁屏、--pointer
 * 缺 env 或与其它 flag 组合、未知 flag/无 flag、前台无应用）。
 * 前置检查在任何 Helper/fork 启动之前完成。
 *
 * 输出纪律（§15.3）：stdout 只输出固定键值行（level/result/duration_ms + 层级专属
 * 数值/布尔/固定枚举字段）；绝不输出凭据、pipe 名、窗口标题、树文本、元素名、截图
 * 字节/base64、临时路径、内部服务地址、用户文档内容。stderr 只输出错误类名与固定结果
 * 码。退出前自证扫描（结构性，不依赖人工审读）：累计 stdout/stderr 命中 \\.\pipe\ 前缀、
 * host 铸造的 socketPath/pluginAuthority 原值、或已知前台窗口标题 → smoke-self-leak +
 * exit 1（泄漏即失败）。
 */
import { createRequire } from "node:module";

import {
  SmokeAssertionError,
  defaultAddonPath,
  entryPath,
  existsSync,
} from "./smoke-lib.mjs";
import { runCapture, runHost, runPointer, runUia } from "./smoke-levels.mjs";

// ── 输出纪律（§15.3；入口是唯一落点，层级函数经 ctx 注入使用）──────────────────
const stdoutChunks = [];
const stderrChunks = [];
const secrets = [];

function emit(line) {
  stdoutChunks.push(line);
  process.stdout.write(`${line}\n`);
}

function emitErr(fixedCode) {
  stderrChunks.push(fixedCode);
  process.stderr.write(`${fixedCode}\n`);
}

/** 登记泄漏扫描秘密值（socketPath/authority 原值；空值防御——includes("") 恒真会误报）。 */
function registerSecret(value) {
  if (typeof value === "string" && value.length > 0) secrets.push(value);
}

/** 退出前自证扫描（§15.3 结构性）：命中即 smoke-self-leak + exit 1。 */
function selfLeakDetected() {
  const text = [...stdoutChunks, ...stderrChunks].join("\n");
  // win32 named pipe 前缀字面量 \\.\pipe\ （JS 转义 "\\\\.\\pipe\\"）。
  if (text.includes("\\\\.\\pipe\\")) {
    return true;
  }
  return secrets.some((secret) => text.includes(secret));
}

function finish(exitCode) {
  if (selfLeakDetected()) {
    // 固定消息（不含任何秘密值本身）；泄漏即失败，不依赖人工审读。
    process.stdout.write("level=self-check result=fail reason=smoke-self-leak\n");
    process.exit(1);
  }
  process.exit(exitCode);
}

// ── 前置（任何 Helper/fork 启动之前完成，§15.3）───────────────────────────────

function usage() {
  emitErr("usage: smoke-real.mjs [--capture] [--uia] [--host] | [--pointer]");
}

const flags = process.argv.slice(2);
const KNOWN_FLAGS = new Set(["--capture", "--uia", "--host", "--pointer"]);
if (flags.length === 0 || flags.some((flag) => !KNOWN_FLAGS.has(flag))) {
  usage();
  finish(2);
}
if (flags.includes("--pointer")) {
  // --pointer 必须单独出现（§15.1）；且须显式 opt-in env（双保险——门禁脚本永不设该 env，
  // 结构上排除误执行）。
  if (flags.length !== 1) {
    emitErr("pointer-flag-must-be-alone");
    finish(2);
  }
  if (process.env.ACODE_CUA_SMOKE_POINTER_LIVE !== "1") {
    emitErr("pointer-live-env-missing");
    finish(2);
  }
}
if (process.platform !== "win32") {
  emitErr("smoke-requires-win32");
  finish(2);
}

// 工件缺失 → exit 2（工具侧 addon 解析规则：env 优先、缺省回退契约相对路径——§15.2，
// 不受 §2.1 的 Helper env 单一来源约束，那条纪律只约束 Helper 运行时进程）。
const addonPath =
  typeof process.env.ACODE_CUA_HELPER_ADDON === "string" && process.env.ACODE_CUA_HELPER_ADDON
    ? process.env.ACODE_CUA_HELPER_ADDON
    : defaultAddonPath;
if (!existsSync(addonPath)) {
  emitErr("artifact-missing");
  finish(2);
}
if ((flags.includes("--host") || flags.includes("--pointer")) && !existsSync(entryPath)) {
  emitErr("artifact-missing");
  finish(2);
}

function loadAddon() {
  try {
    return createRequire(import.meta.url)(addonPath);
  } catch {
    // addon 加载被拒（SAC/ABI/损坏，C12 同语义）→ exit 2；不打印底层文本（可能含路径）。
    emitErr("addon-load-failed");
    finish(2);
  }
}

// ── 主流程（层级顺序固定：capture → uia → host → pointer；pointer 恒单独）─────

const ctx = { emit, emitErr, finish, registerSecret, loadAddon };

let exitCode = 0;
try {
  if (flags.includes("--capture")) {
    exitCode = Math.max(exitCode, await runCapture(ctx).catch((error) => {
      emit(`level=capture result=fail duration_ms=0 reason=${error instanceof SmokeAssertionError ? error.reason : "capture-failure"}`);
      emitErr(error?.name ?? "Error");
      return 1;
    }));
  }
  if (flags.includes("--uia")) {
    exitCode = Math.max(exitCode, await runUia(ctx));
  }
  if (flags.includes("--host")) {
    exitCode = Math.max(exitCode, await runHost(ctx));
  }
  if (flags.includes("--pointer")) {
    exitCode = Math.max(exitCode, await runPointer(ctx));
  }
} catch (error) {
  // 层级函数自身已兜底；这里是最后防线（固定字面量，零插值）。
  emitErr("smoke-internal-failure");
  emitErr(error?.name ?? "Error");
  exitCode = 1;
}
finish(exitCode);
