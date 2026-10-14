/**
 * 真机烟测（specs/windows-helper-producer.md §15 契约；A2 交付层级 = --capture/--host/
 * --pointer，--uia 属 A3）。仓库侧 dev/验收工具，不是 Helper 运行时面——§1.1 解析隔离
 * 只约束 dist/windows-helper.js 进程；本脚本允许经 tsx 深导入 workspace TS（§15.1）。
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
 * 缺 env 或与其它 flag 组合、未知 flag/无 flag、前台无应用、A2 切片的 --uia 未实现）。
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
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const producerRoot = resolve(here, "..");
const repoRoot = resolve(producerRoot, "..");
const entryPath = join(producerRoot, "dist", "windows-helper.js");
const defaultAddonPath = join(producerRoot, "build", "Release", "ax_native.node");

// §15.2 --capture 断言常量（§10.7 预算阶梯钉死取值；与 producer driver-contract 同值）。
const CAPTURE_MAX_DIMENSION = 2000;
const CAPTURE_INLINE_BASE64_BUDGET_BYTES = 200 * 1024;
// §10.6/§10.12 收据固定字面量（断言锚：wire 面必须逐字供给）。
const STOPPED_MESSAGE = "Computer Use control stopped; held inputs released.";
const INTERRUPTED_MESSAGE = "Computer Use action was interrupted by stop_computer_control.";
const VK_F13 = 0x7c;

// ── 输出纪律（§15.3）──────────────────────────────────────────────────────────
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

class SmokeAssertionError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "SmokeAssertionError";
    this.reason = reason;  // 固定结果码（绝不插值动态内容）
  }
}

function assertTrue(condition, reason) {
  if (!condition) throw new SmokeAssertionError(reason);
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
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

// ── --capture（A2 段：addon 直载；A3 扩展 wire get_app_state 段）──────────────

async function runCapture() {
  const startedAt = Date.now();
  const addon = loadAddon();
  const environment = await addon.environmentProbe();
  assertTrue(
    environment && typeof environment === "object",
    "environment-probe-shape",
  );
  if (!environment.interactiveDesktop || environment.sessionZero) {
    // 非交互桌面/锁屏 = 前置失败（非层级失败），且在启动任何子进程前退出（§15.3）。
    emitErr("non-interactive-desktop");
    finish(2);
  }
  const capture = await addon.captureDisplay(
    { monitorIndex: 0 },
    { maxDimension: CAPTURE_MAX_DIMENSION, inlineBase64BudgetBytes: CAPTURE_INLINE_BASE64_BUDGET_BYTES },
  );
  const durationMs = Date.now() - startedAt;
  // 断言面（§15.2）：魔数/encoding 一致、尺寸 ≤2000 且 >0、base64 折算 ≤200 KiB、
  // bounds 宽高 >0、budgetFit===true、scaled 与尺寸事实一致。
  // 图像字节不落盘、不打印、断言即弃（屏幕内容是隐私面）。
  assertTrue(capture && typeof capture === "object", "capture-result-shape");
  const bytes = capture.image;
  assertTrue(bytes instanceof Uint8Array && bytes.length > 0, "capture-image-bytes");
  const base64Bytes = Math.ceil(bytes.length / 3) * 4;
  if (capture.encoding === "png") {
    assertTrue(
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47,
      "capture-png-magic",
    );
  } else if (capture.encoding === "jpeg") {
    assertTrue(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff, "capture-jpeg-magic");
  } else {
    throw new SmokeAssertionError("capture-encoding-unknown");
  }
  assertTrue(
    Number.isInteger(capture.width) && capture.width > 0 && capture.width <= CAPTURE_MAX_DIMENSION,
    "capture-width-bound",
  );
  assertTrue(
    Number.isInteger(capture.height) && capture.height > 0 && capture.height <= CAPTURE_MAX_DIMENSION,
    "capture-height-bound",
  );
  assertTrue(base64Bytes <= CAPTURE_INLINE_BASE64_BUDGET_BYTES, "capture-base64-budget");
  assertTrue(
    capture.bounds && capture.bounds.width > 0 && capture.bounds.height > 0,
    "capture-bounds-positive",
  );
  assertTrue(capture.budgetFit === true, "capture-budget-fit");
  // scaled 与尺寸事实一致：未缩放 ⇒ 栅格 = bounds 尺寸；缩放 ⇒ 栅格严格小于 bounds。
  if (capture.scaled === true) {
    assertTrue(
      capture.width < capture.bounds.width || capture.height < capture.bounds.height,
      "capture-scaled-consistency",
    );
  } else {
    assertTrue(
      capture.width === capture.bounds.width && capture.height === capture.bounds.height,
      "capture-scaled-consistency",
    );
  }
  emit(
    `level=capture result=pass duration_ms=${durationMs} png_bytes=${bytes.length} width=${capture.width} height=${capture.height} encoding=${capture.encoding} scaled=${capture.scaled} budget_fit=${capture.budgetFit} base64_bytes=${base64Bytes}`,
  );
  return 0;
}

// ── --host（A2 段：生命周期面，不需要模型 cell，§15.2）───────────────────────

async function importHostSurface() {
  const servicesDir = join(repoRoot, "packages", "services", "src", "cua-permission-broker");
  const runtimeModule = await import(
    pathToFileURL(join(servicesDir, "windowsCuaDevRuntime.ts")).href
  );
  const hostModule = await import(pathToFileURL(join(servicesDir, "windowsCuaDevHelperHost.ts")).href);
  const brokerModule = await import(pathToFileURL(join(repoRoot, "packages", "acode-cua", "broker.js")).href);
  return { ...runtimeModule, ...hostModule, ...brokerModule };
}

function createCapturingLogger(sink) {
  // 捕获型 logger（ServiceLogger 形状）：host 日志可能含 socketPath——只进内存扫描面，
  // 绝不进本脚本 stdout/stderr。首参 traceId 是 ServiceLogger 签名事实，本脚本不消费。
  const capture = (level) => (_traceId, ...args) => {
    sink.push({ level, args });
  };
  return {
    debug: capture("debug"),
    info: capture("info"),
    warn: capture("warn"),
    error: capture("error"),
  };
}

function probePipeRefused(socketPath) {
  return new Promise((resolvePromise) => {
    const socket = connect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolvePromise(false);
    }, 3000);
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(error?.code === "ENOENT");
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(false);  // 还能连上 = 未拒连
    });
  });
}

async function runHost() {
  const startedAt = Date.now();
  const { resolveWindowsCuaRuntime, WindowsCuaHelperHost, probeHelperHealth, callBrokerMethod } =
    await importHostSurface();
  // dev 链解析（§15.2 步骤 1：真解析器，ACODE_CUA_DEV_ROOT 指向 producer）。
  const runtime = await resolveWindowsCuaRuntime({
    platform: "win32",
    env: { ACODE_CUA_DEV_ROOT: producerRoot },
  });
  const logSink = [];
  const host = new WindowsCuaHelperHost({ runtime, logger: createCapturingLogger(logSink) });
  let handle;
  try {
    handle = await host.start();
    registerSecret(handle.socketPath);
    registerSecret(handle.pluginAuthority);
    // C05 split-brain 教训（§15.2 步骤 3）：仅 env tuple 不算数——host.running 必须为真。
    assertTrue(host.running === true, "host-running");
    const health = await probeHelperHealth(handle.socketPath, { timeoutMs: 15_000 });
    const pidMatch = health.pid === handle.pid;
    assertTrue(pidMatch, "host-pid-match");
    // A2 切片（§15.2 步骤 4）：broker_info 一次（capabilities 形状断言）。
    const info = await callBrokerMethod({
      socketPath: handle.socketPath,
      method: "broker_info",
      timeoutMs: 5_000,
    });
    assertTrue(info && info.pid === handle.pid, "broker-info-pid");
    assertTrue(typeof info.bundle_id === "string" && info.bundle_id.length > 0, "broker-info-bundle-id");
    const capabilities = info.capabilities;
    assertTrue(capabilities && typeof capabilities === "object", "broker-info-capabilities-shape");
    for (const key of ["input", "capture", "clipboard"]) {
      assertTrue(typeof capabilities[key] === "boolean", "broker-info-capabilities-shape");
    }
    // 步骤 5：stop() → 子进程退出（stop 以 lifecycle tail 等待 exact child exit 后 resolve）
    // ∧ 旧 pipe 拒连（ENOENT）∧ 全程 <5s。
    await host.stop();
    assertTrue(host.running === false, "host-stopped");
    const refused = await probePipeRefused(handle.socketPath);
    assertTrue(refused, "host-pipe-refused-after-stop");
    const durationMs = Date.now() - startedAt;
    assertTrue(durationMs < 5_000, "host-duration-budget");
    emit(
      `level=host result=pass duration_ms=${durationMs} running=true pid_match=true exit_code=0 capabilities_input=${capabilities.input} capabilities_capture=${capabilities.capture} capabilities_clipboard=${capabilities.clipboard} pipe_refused=true`,
    );
    return 0;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const reason = error instanceof SmokeAssertionError ? error.reason : "host-lifecycle-failure";
    emit(`level=host result=fail duration_ms=${durationMs} reason=${reason}`);
    emitErr(error?.name ?? "Error");
    try {
      await host.stop();
    } catch {
      // 清理失败不改变层级 fail 结论（host 内部有终止链兜底）。
    }
    return 1;
  }
}

// ── --pointer（人工 C07 专属；操作者在场、已解锁交互桌面，§15.2）──────────────
// 破坏性边界（如实登记）：本脚本不含任何真实点击/键入用户应用——只有光标移动/还原
// （≤24 坐标单位、≤2px 容差复原）、零滚动量探针、f13（无害键）hold + wire stop 中断
// 时序。鼠标键实压配对不在任何自动化面（真机点击证据归 A3 wire 级人工 C07）。

async function runPointer() {
  const startedAt = Date.now();
  const addon = loadAddon();
  const environment = await addon.environmentProbe();
  if (!environment.interactiveDesktop || environment.sessionZero || !environment.dpiAware) {
    emitErr("non-interactive-desktop");
    finish(2);
  }
  // 步骤 1：记录原始光标位置；取当前前台应用 pid 为 app_ref。
  const original = await addon.cursorPosition();
  const foreground = await addon.foregroundPid();
  if (!foreground.pid) {
    emitErr("no-foreground-app");
    finish(2);
  }
  const pid = foreground.pid;
  const { resolveWindowsCuaRuntime, WindowsCuaHelperHost, callBrokerMethod } =
    await importHostSurface();
  const runtime = await resolveWindowsCuaRuntime({
    platform: "win32",
    env: { ACODE_CUA_DEV_ROOT: producerRoot },
  });
  const logSink = [];
  const host = new WindowsCuaHelperHost({ runtime, logger: createCapturingLogger(logSink) });
  let handle;
  let cursorDeltaPx = -1;
  try {
    // 步骤 2：moveTo 向所在显示器中心移动 ≤24 坐标单位 → foregroundPid 复核 → 还原（≤2px）。
    // 显示器几何经 captureDisplay bounds 取得（只读；图像断言即弃、绝不输出）。
    const geometry = await addon.captureDisplay(
      { monitorIndex: 0 },
      { maxDimension: CAPTURE_MAX_DIMENSION, inlineBase64BudgetBytes: CAPTURE_INLINE_BASE64_BUDGET_BYTES },
    );
    const centerX = geometry.bounds.x + geometry.bounds.width / 2;
    const centerY = geometry.bounds.y + geometry.bounds.height / 2;
    const stepToward = (from, toward) => {
      const distance = Math.abs(toward - from);
      const step = Math.min(24, Math.round(distance));
      return from + (toward >= from ? step : -step);
    };
    const target = { x: stepToward(original.x, centerX), y: stepToward(original.y, centerY) };
    await addon.moveTo(target.x, target.y, { expectedForegroundPid: pid });
    const midForeground = await addon.foregroundPid();
    assertTrue(midForeground.pid === pid, "pointer-foreground-stable");
    await addon.moveTo(original.x, original.y, { expectedForegroundPid: pid });
    const restored = await addon.cursorPosition();
    cursorDeltaPx = Math.max(Math.abs(restored.x - original.x), Math.abs(restored.y - original.y));
    assertTrue(cursorDeltaPx <= 2, "pointer-cursor-restored-2px");
    // 步骤 3：scrollAt(amount:0) 探针（零滚动量，无副作用；光标定位到原位 = 无移动）。
    await addon.scrollAt(original.x, original.y, 0, 0, { expectedForegroundPid: pid });
    // 步骤 4：wire 级中断时序（fork 真 Helper；对齐上游 hold_key 中断验收机制）。
    handle = await host.start();
    registerSecret(handle.socketPath);
    registerSecret(handle.pluginAuthority);
    const keyPromise = callBrokerMethod({
      socketPath: handle.socketPath,
      method: "key",
      params: { text: "f13", app_ref: { pid }, hold_seconds: 5 },
      timeoutMs: 15_000,
    }).then(
      (receipt) => ({ receipt }),
      (error) => ({ error }),
    );
    await delay(1_000);
    const stopSentAt = Date.now();
    const stopReceipt = await callBrokerMethod({
      socketPath: handle.socketPath,
      method: "stop_computer_control",
      timeoutMs: 10_000,
    });
    const keyOutcome = await keyPromise;
    const interruptMs = Date.now() - stopSentAt;
    // stop 收据（§10.6 ⑤ 固定字面量）。
    assertTrue(stopReceipt && stopReceipt.isError !== true, "pointer-stop-receipt-ok");
    assertTrue(
      stopReceipt.structuredContent?.dispatch_status === "accepted" &&
        stopReceipt.structuredContent?.action_sent === true &&
        stopReceipt.structuredContent?.message === STOPPED_MESSAGE,
      "pointer-stop-receipt-shape",
    );
    // key 调用在 ≤1.5s 内以 interrupted 收据收口（§10.6/§15.2 步骤 4）。
    assertTrue(keyOutcome.receipt !== undefined, "pointer-key-receipt-present");
    const keyReceipt = keyOutcome.receipt;
    assertTrue(keyReceipt.isError === true, "pointer-key-interrupted-is-error");
    assertTrue(
      keyReceipt.structuredContent?.dispatch_status === "accepted" &&
        keyReceipt.structuredContent?.action_sent === true &&
        keyReceipt.structuredContent?.code === "controller_busy" &&
        keyReceipt.structuredContent?.message === INTERRUPTED_MESSAGE,
      "pointer-key-interrupted-shape",
    );
    assertTrue(interruptMs <= 1_500, "pointer-interrupt-1500ms");
    // 烟测进程自载 addon 的系统级全局键态：跨进程独立佐证 Helper 无 held 遗留
    // （held 注册表是 Helper 进程内的，烟测进程读不到，故必须用系统事实面验证）。
    const f13State = await addon.asyncKeyState(VK_F13);
    assertTrue(f13State.down === false, "pointer-f13-released-system-wide");
    const durationMs = Date.now() - startedAt;
    emit(
      `level=pointer result=pass duration_ms=${durationMs} cursor_delta_px=${cursorDeltaPx} interrupt_ms=${interruptMs} key_released=true released_count=${stopReceipt.structuredContent?.released_inputs ?? 0}`,
    );
    return 0;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const reason = error instanceof SmokeAssertionError ? error.reason : "pointer-sequence-failure";
    emit(`level=pointer result=fail duration_ms=${durationMs} reason=${reason} cursor_delta_px=${cursorDeltaPx}`);
    emitErr(error?.name ?? "Error");
    return 1;
  } finally {
    // 步骤 5（finally）：还原光标位置（≤2px 断言尽力而为）→ Helper shutdown。
    try {
      // 还原用当前前台 pid（前台可能已变化；moveTo 的前台校验以现值为准——还原是
      // cleanup 性质的尽力动作）。
      const nowForeground = await addon.foregroundPid();
      if (nowForeground.pid) {
        await addon.moveTo(original.x, original.y, { expectedForegroundPid: nowForeground.pid });
        const final = await addon.cursorPosition();
        const finalDelta = Math.max(Math.abs(final.x - original.x), Math.abs(final.y - original.y));
        if (finalDelta > 2) emitErr("pointer-cursor-restore-degraded");
      }
    } catch {
      emitErr("pointer-cursor-restore-failed");
    }
    try {
      await host.stop();
    } catch {
      emitErr("pointer-host-stop-failed");
    }
    void handle;
  }
}

// ── --uia（A3 起；A2 切片 = 诚实桩）──────────────────────────────────────────

async function runUia() {
  // A2 无 UIA 观察面（§15.2 --uia 属 A3）：层级 skipped + 前置失败 exit 2（诚实
  // fail-closed；A3 批次落地真实现后本桩移除——spec §15.2 同批回写登记）。
  emit("level=uia result=skipped duration_ms=0");
  emitErr("uia-level-arrives-in-a3");
  return 2;
}

// ── 主流程（层级顺序固定：capture → uia → host → pointer；pointer 恒单独）─────

let exitCode = 0;
try {
  if (flags.includes("--capture")) {
    exitCode = Math.max(exitCode, await runCapture().catch((error) => {
      emit(`level=capture result=fail duration_ms=0 reason=${error instanceof SmokeAssertionError ? error.reason : "capture-failure"}`);
      emitErr(error?.name ?? "Error");
      return 1;
    }));
  }
  if (flags.includes("--uia")) {
    exitCode = Math.max(exitCode, await runUia());
  }
  if (flags.includes("--host")) {
    exitCode = Math.max(exitCode, await runHost());
  }
  if (flags.includes("--pointer")) {
    exitCode = Math.max(exitCode, await runPointer());
  }
} catch (error) {
  // 层级函数自身已兜底；这里是最后防线（固定字面量，零插值）。
  emitErr("smoke-internal-failure");
  emitErr(error?.name ?? "Error");
  exitCode = 1;
}
finish(exitCode);
