/**
 * Windows CUA Helper entry（specs/windows-helper-producer.md §2 进程模型）。
 *
 * 薄层：argv/env/IPC 校验、状态机接线（STARTING→WARMING→READY→STOPPING）、named pipe
 * wire 服务端的生命周期、parent-pid watchdog。协议/派发逻辑在 wire-server.ts（可独立单测），
 * addon 加载在 native-loader.ts，控制消息在 control-protocol.ts。
 *
 * 解析隔离（§1.1）：本进程只 import `node:` 内建与 `./` 相对模块，禁止任何裸包名。
 * 纪律红线：永不写 stdout（§2.7）；stderr 只写稳定字面量/错误类别，绝不含 socketPath、
 * 凭据值、屏幕内容（§2.7/§3.2）；控制消息与 wire error 全为封闭字面量、零插值（§3.2）。
 */
import { createServer, type Server, type Socket } from "node:net";

import { createBackendA2 } from "./backend-a2.js";
import {
  EXIT_CODE_BY_FAILURE,
  HELPER_ADDON_ENV,
  MISSING_IPC_CHANNEL_MESSAGE,
  errorControlMessage,
  isShutdownMessage,
  readyMessage,
  transportReadyMessage,
  type HelperFailureMessage,
} from "./control-protocol.js";
import { createFrameRegistry } from "./frame-registry.js";
import {
  createExitConvergence,
  createInputSession,
  watchdogIntervalMs,
  type ExitConvergence,
  type InputSession,
} from "./input-session.js";
import { loadNativeAddon } from "./native-loader.js";
import { createNativeDriver } from "./native-driver.js";
import {
  CONNECTION_IDLE_TIMEOUT_MS,
  MAX_REQUEST_LINE_BYTES,
  createWireDispatcher,
  serializeResponse,
  type WireDispatcher,
} from "./wire-server.js";

/** argv --socket 在 win32 上必须以此前缀开头（§2.1：防把任意文件系统路径交给 net.listen）。 */
const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";

interface HelperArguments {
  readonly socketPath: string;
  readonly parentPid: number;
}

// 运行期可变状态（entry 是单进程状态机 owner，§1.3；不被单测导入，故用模块级状态）。
let server: Server | undefined;
const trackedSockets = new Set<Socket>();
let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
let shuttingDown = false;
// A2 会话层（READY 后装配）：session（admission/held 镜像）供 watchdog 自适应判据；
// driver 经 exitConvergence 闭包持有（组装局部），无模块级读者。
let session: InputSession | undefined;
// 退出收口点（§10.4 规则 3「统一收口」）：scheduleFailure / beginShutdown / A3 poison
// 自终结全部经它幂等执行「取消在途 + 释放 held ≤300ms」后再退出。
let exitConvergence: ExitConvergence | undefined;

/**
 * argv 严格白名单解析（§2.1）：只接受 `--socket <非空、win32 须 \\.\pipe\ 前缀>` 与
 * `--parent-pid <正整数>`，两者必现且各一次；未知 flag、缺失、重复、前缀不符 → undefined
 * （→ invalid-helper-arguments，exit 1）。前缀校验防止把任意文件系统路径交给 net.listen。
 */
export function parseHelperArguments(argv: readonly string[]): HelperArguments | undefined {
  let socketPath: string | undefined;
  let parentPid: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--socket") {
      if (socketPath !== undefined || typeof value !== "string" || value.length === 0) {
        return undefined;
      }
      if (process.platform === "win32" && !value.startsWith(WINDOWS_PIPE_PREFIX)) return undefined;
      socketPath = value;
      index += 1;
    } else if (flag === "--parent-pid") {
      if (parentPid !== undefined || typeof value !== "string") return undefined;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
      parentPid = parsed;
      index += 1;
    } else {
      return undefined; // 未知 flag
    }
  }
  if (socketPath === undefined || parentPid === undefined) return undefined;
  return { socketPath, parentPid };
}

/** 发一条控制消息（best-effort：IPC 已断时静默丢弃，不因发送失败崩进程）。 */
function sendControl(message: unknown): void {
  if (typeof process.send !== "function") return;
  try {
    process.send(message);
  } catch {
    // IPC 通道已关闭：宿主已不再监听，无可报告对象。
  }
}

/**
 * fail() 的哨兵异常：只携带 §2.7 封闭字面量（零插值，无敏感内容）。作用是让「已排程失败
 * 退出」的控制流同步中止（调用点之后的代码绝不执行），同时可被 main().catch / 进程级错误
 * 处理器识别为「失败已受理」——若抛的是普通 Error，会级联触发 unhandledRejection →
 * 二次 fail → 宿主收到两条 error 消息甚至递归（实现期自查发现的缺陷形态，此处结构性排除）。
 */
class HelperFailureSignal extends Error {
  constructor(readonly literal: HelperFailureMessage) {
    super(literal);
    this.name = "HelperFailureSignal";
  }
}

let failing = false;

/**
 * 退出前的 held 释放收口（§10.4 规则 3）：一切退出路径在 process.exit 前经
 * exitConvergence.converge() 幂等执行「cancelOperations + releaseAllHeldInputs」，
 * 预算 ≤300ms（宿主 shutdownTimeoutMs=1s 地板内）；超时/失败不阻断退出（兜底后仍退出）。
 * 收口点在 scheduleFailure/beginShutdown 内统一挂接——枚举会漏、收口点不会，后续切片
 * 新增退出路径（含 A3 poisoned≥3 自终结）自动被覆盖。
 */
async function convergeBeforeExit(): Promise<void> {
  if (!exitConvergence) return;
  await exitConvergence.converge();
}

/**
 * 排程失败退出（§2.7 封闭表，幂等）：拆运行时 → held 释放收口（≤300ms）→ 尽力把 error
 * 控制消息 flush 到宿主 → 按退出码退出。用 process.send 的回调保证消息落地后才 exit
 * （同步 exit 可能丢消息，宿主把该 message 进日志作诊断，windowsCuaDevHelperHost.ts:396-399）；
 * 回调丢失（通道已断）时 100ms 非-unref 定时器兜底强制退出。首个失败类别胜出（根因先于
 * 级联），重复调用 no-op。最坏路径 300+100=400ms，仍在宿主 1s 终止预算内。
 */
function scheduleFailure(message: HelperFailureMessage, exitCode: 1 | 2): void {
  if (failing) return;
  failing = true;
  teardownRuntime();
  void convergeBeforeExit().then(() => {
    let exited = false;
    const exitOnce = (): void => {
      if (exited) return;
      exited = true;
      process.exit(exitCode);
    };
    if (typeof process.send === "function") {
      try {
        process.send(errorControlMessage(message), exitOnce);
      } catch {
        exitOnce();
      }
      setTimeout(exitOnce, 100); // 刻意不 unref：保证进程活到退出落地。
    } else {
      exitOnce();
    }
  });
}

/** 主流程失败入口：排程退出 + 抛哨兵中止后续控制流（永不返回，TS never）。 */
function fail(message: HelperFailureMessage, exitCode: 1 | 2): never {
  scheduleFailure(message, exitCode);
  throw new HelperFailureSignal(message);
}

/** STOPPING 拆除（§2.4）：停 accept、destroy 在途连接、close server、清 watchdog。 */
function teardownRuntime(): void {
  if (watchdogTimer !== undefined) {
    clearTimeout(watchdogTimer);
    watchdogTimer = undefined;
  }
  if (server !== undefined) {
    try {
      server.close();
    } catch {
      // close 失败不影响退出路径。
    }
    server = undefined;
  }
  for (const socket of trackedSockets) {
    try {
      socket.destroy();
    } catch {
      // 单个连接 destroy 失败不阻断其余清理。
    }
  }
  trackedSockets.clear();
}

/**
 * 进入 STOPPING 并 exit 0（§2.4/§2.7：shutdown 或 parent 消失，宿主 1s 内须完成）。
 * A2 增量（§10.4 规则 3）：exit 前经统一收口点幂等释放 held input（≤300ms 预算，
 * converge 内先 cancelOperations 令在途注入循环尽快退出）。
 */
function beginShutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  teardownRuntime();
  void convergeBeforeExit().then(() => process.exit(0));
}

/**
 * 单连接处理（§2.6 服务端硬化）：行缓冲上限 1 MiB（超限 destroy 不应答）；单连接单请求
 * （应答一行后 server 侧 end()，同连接再来请求行 → destroy）；空闲 30s → destroy。
 * A1 无共享可变 native 状态，不做并发限流（A2 引入输入序列化时须重审 admission）。
 */
function handleConnection(socket: Socket, dispatcher: WireDispatcher): void {
  if (shuttingDown) {
    socket.destroy();
    return;
  }
  trackedSockets.add(socket);
  // 字节级行缓冲（spec §17.2 修复）：旧实现按 chunk 逐个 toString("utf8") 累积字符串，
  // 多字节 UTF-8 字符（中文 3 字节 / emoji 4 字节）跨 chunk 劈裂时产生不可逆 U+FFFD 损坏；
  // 且 1 MiB cap 对已损坏重编码的字符串量长，与 wire 原始字节数漂移。
  // 修复 = Buffer.concat 累积原始字节、字节域扫描 0x0A 切行、完整行字节一次性 toString、
  // cap 按原始字节长度判定（请求行 JSON 无裸 \n，wire spec §1.3，字节切行安全）。
  // 注：本注释刻意不复现旧缺陷代码形态——契约测试对源文本做 doesNotMatch 回归断言。
  let buffer: Buffer = Buffer.alloc(0);
  let responded = false;
  let settled = false;

  const idleTimer = setTimeout(() => socket.destroy(), CONNECTION_IDLE_TIMEOUT_MS);
  idleTimer.unref?.();

  const detach = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(idleTimer);
    trackedSockets.delete(socket);
  };

  socket.on("error", () => socket.destroy());
  socket.on("close", detach);
  socket.on("data", (chunk: Buffer) => {
    // 已应答或已关闭后再收数据 = 协议违约（单连接单请求），destroy 不应答（§2.6）。
    if (responded || settled) {
      socket.destroy();
      return;
    }
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_REQUEST_LINE_BYTES) {
      socket.destroy(); // 行缓冲超 1 MiB（按 wire 原始字节判定，§17.2）：直接拆，不应答（§2.6）。
      return;
    }
    const newline = buffer.indexOf(0x0a);
    if (newline === -1) return; // 完整请求行未到，继续等（空闲定时器兜底）。
    const line = buffer.subarray(0, newline).toString("utf8");
    responded = true;
    void dispatcher.handleRequestLine(line).then(
      (response) => {
        if (settled) return;
        try {
          socket.write(serializeResponse(response));
          socket.end(); // server 侧 end（§2.6）；客户端负责 destroy。
        } catch {
          socket.destroy();
        }
      },
      () => socket.destroy(),
    );
  });
}

/** 绑定 named pipe（逐字 bind argv --socket 原值，绝不自铸/改名，§2.3）。 */
function listenPipeServer(target: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      target.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      target.removeListener("error", onError);
      resolve();
    };
    target.once("error", onError);
    target.once("listening", onListening);
    target.listen(socketPath);
  });
}

/**
 * parent-pid watchdog（§2.8 ACode 自定 + §10.8 A2 自适应收紧）：`process.kill(parentPid, 0)`
 * 探活；ESRCH → 父进程消失 → STOPPING 同路径清理并 exit 0（stderr 字面量
 * parent-process-gone；退出前经统一收口释放 held——「父进程消失不遗留按住键」纪律，
 * 按键遗留窗口 ≤250ms + 释放时长）；EPERM 及其它错误 → 视为存活（保守：宁可不退，
 * 不可误退）。
 *
 * 间隔自适应（§10.8）：held 镜像为空 → 2000ms；非空（任何 mouseDown/hold/drag 在途）
 * → 250ms。**重臂是事件驱动而非仅 tick 边界重算**（2026-10-14 评审修复）：session 的
 * onHeldChange（held 镜像 0↔非空迁移，O(1)）直接接 armWatchdog——若只在 tick 边界
 * 重算，held 0→非空迁移发生在 idle tick 刚过之后时，检测延迟最坏仍 ~2000ms，
 * §10.8「按键遗留窗口从 ≤2s 收紧到 ≤250ms+释放时长」在该角落不成立。迁移即重臂后，
 * held 非空期间的最坏检测延迟 = 250ms（当前间隔），spec 主张结构性成立。
 * 定时器 unref。
 */
let watchdogParentPid: number | undefined;

/** 按当前 held 状态（重）臂 watchdog；startWatchdog 前 / STOPPING / 失败路径中为 no-op。 */
function armWatchdog(): void {
  if (watchdogTimer !== undefined) {
    clearTimeout(watchdogTimer);
    watchdogTimer = undefined;
  }
  if (watchdogParentPid === undefined || shuttingDown || failing) return;
  watchdogTimer = setTimeout(watchdogTick, watchdogIntervalMs(session?.hasHeldInput() ?? false));
  watchdogTimer.unref?.();
}

function watchdogTick(): void {
  watchdogTimer = undefined;
  if (shuttingDown || failing || watchdogParentPid === undefined) return;
  let alive = true;
  try {
    process.kill(watchdogParentPid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") alive = false;
    // EPERM / 其它：保守视为存活，不退出。
  }
  if (!alive) {
    process.stderr.write("parent-process-gone\n");
    beginShutdown();
    return;
  }
  armWatchdog();
}

function startWatchdog(parentPid: number): void {
  watchdogParentPid = parentPid;
  armWatchdog();
}

async function main(): Promise<void> {
  // 无 IPC 通道（非 fork 启动）：无法向宿主报告任何事，stderr 稳定字面量后 exit 1（§2.1/§2.7）。
  // 字面量单一来源 = control-protocol.ts 的 MISSING_IPC_CHANNEL_MESSAGE（§17.3 双写裁决，
  // 防「改一处漏一处」的 stderr 诊断面与封闭表失配）。
  if (typeof process.send !== "function") {
    process.stderr.write(`${MISSING_IPC_CHANNEL_MESSAGE}\n`);
    process.exit(1);
  }
  // 平台双保险（§2.1：宿主解析层已挡 non-win32，此处再挡一次）。
  if (process.platform !== "win32") fail("unsupported-platform", 1);

  const args = parseHelperArguments(process.argv.slice(2));
  if (!args) fail("invalid-helper-arguments", 1);
  const { socketPath, parentPid } = args as HelperArguments;

  // addon 路径只取自 env（§2.1）：缺失 → native-addon-env-missing，exit 2（STARTING 期校验，
  // 早于 bind，故不发 transport_ready）。不回退契约相对路径——回退会掩盖宿主接线错误。
  const addonEnv = process.env[HELPER_ADDON_ENV];
  if (typeof addonEnv !== "string" || addonEnv.trim().length === 0) {
    fail("native-addon-env-missing", 2);
  }

  // 未捕获异常/rejection：尽力发 internal-helper-failure + exit 1（§2.7）。用 scheduleFailure
  // （不抛）——在错误处理器内再抛会级联触发新一轮 uncaughtException。哨兵异常 = 失败已受理，
  // 静默等排程的退出落地。stderr 只写错误类别（error.name），不写 message/stack——杜绝
  // socketPath/凭据/屏幕内容泄漏（§2.7 红线；本进程所有自建错误面都是封闭字面量）。
  process.on("uncaughtException", (error: unknown) => {
    if (error instanceof HelperFailureSignal) return;
    process.stderr.write(`internal-helper-failure ${error instanceof Error ? error.name : "unknown"}\n`);
    scheduleFailure("internal-helper-failure", 1);
  });
  process.on("unhandledRejection", (reason: unknown) => {
    if (reason instanceof HelperFailureSignal) return;
    process.stderr.write(`internal-helper-failure unhandledRejection ${reason instanceof Error ? reason.name : "unknown"}\n`);
    scheduleFailure("internal-helper-failure", 1);
  });
  // 入站 shutdown（§2.2）：宿主发 { protocol, type: "shutdown" } → STOPPING；其它入站消息忽略。
  process.on("message", (message: unknown) => {
    if (isShutdownMessage(message)) beginShutdown();
  });

  // STARTING → 建 wire 服务端（此刻 dispatcher 处 warming：绑定后、ready 前到达的请求
  // 一律 broker_unavailable，§2.5；A1 的 warming 窗口由 wire-server 单测确定性覆盖）。
  const dispatcher = createWireDispatcher();
  const netServer = createServer((socket) => handleConnection(socket, dispatcher));
  server = netServer;
  netServer.on("error", () => {
    // 运行期 server 错误：挂 error handler 防未处理 'error' 崩进程；不打印原始错误（含路径）。
  });

  try {
    await listenPipeServer(netServer, socketPath);
  } catch {
    fail("transport-bind-failed", 1); // 名字被占/权限拒绝：诚实失败，不回退其它名字（§2.3）。
  }

  // WARMING：pipe 已 bind，发 transport_ready（socketPath 逐字回显、pid 为自身正整数，§2.2）。
  sendControl(transportReadyMessage(socketPath, process.pid));

  // 功能层：加载 addon（同步、fail-closed）。失败 → native-addon-load-failed，exit 2，
  // 绝不降级为「无 addon 模式」继续跑（§3.4 C12 / 能力真实性红线）。
  const outcome = loadNativeAddon(process.env);
  if (!outcome.ok) fail(outcome.failure, EXIT_CODE_BY_FAILURE[outcome.failure]);

  // READY 装配（§2.4「注入 backend，状态=READY」）：真 driver（native-driver 只被本组装
  // 路径 import，§10.11 规则②）→ 会话层（admission 队列 + held 镜像）→ frame 注册表 →
  // A2 backend（8 handler；A2 导出缺席时按 capabilities 诚实降级为不注册 → unimplemented，
  // §10.9 两面同源）。A1 backend（仅 broker_info）保留给单测/历史面，不再上生产路径。
  const realDriver = createNativeDriver(outcome.addon);
  // onHeldChange → armWatchdog：held 镜像 0↔非空迁移即时重臂探活间隔（§10.8「间隔重置
  // 成本 O(1)」的结构化落点；仅 tick 边界重算会让 0→非空迁移后的最坏检测延迟仍 ~2000ms，
  // 2026-10-14 评审修复）。armWatchdog 在 startWatchdog 之前是 no-op（parentPid 未装配）。
  const inputSession = createInputSession(realDriver, { onHeldChange: armWatchdog });
  session = inputSession;
  const frames = createFrameRegistry();
  exitConvergence = createExitConvergence({
    cancel: () => realDriver.cancelOperations(),
    release: () => realDriver.releaseAllHeldInputs(),
  });

  dispatcher.activate(createBackendA2({ driver: realDriver, session: inputSession, frames }));
  sendControl(readyMessage(socketPath, process.pid));

  // 就绪后启动 watchdog（§2.8/§10.8 自适应）：父进程消失即自清理退出（先经收口释放
  // held），防进程、pipe 实例与按住键泄漏。
  startWatchdog(parentPid);
}

void main().catch((error: unknown) => {
  // 哨兵 = fail() 已排程正确的失败类别与退出码，不得再覆盖成 internal-helper-failure。
  if (error instanceof HelperFailureSignal) return;
  scheduleFailure("internal-helper-failure", 1);
});
