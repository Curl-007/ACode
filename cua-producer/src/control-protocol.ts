/**
 * 控制面协议常量与消息构造（specs/windows-helper-producer.md §2.1/§2.2/§2.7）。
 *
 * ACode 原创实现：Helper 运行时进程的模块解析只允许 node: 内建与 dist/ 内部相对导入
 * （§1.1 解析隔离），故协议常量值（接口事实）在本树内自持——不从 @acode/acode-cua 占位包
 * import（两种加载模式下都解析不到，§1.2），也不复制其表达。
 */

/** 控制协议名——与宿主 windowsCuaHelperHostSupport.ts 的 CONTROL_PROTOCOL 值全等（接口事实）。 */
export const CONTROL_PROTOCOL = "acode-cua-windows-dev/v1";

/**
 * addon 路径唯一来源 env（§2.1）：不回退契约相对路径 build/Release/ax_native.node——
 * 宿主 dev/产品两种模式都已注入该 env，回退会让「宿主接线错误」被静默掩盖，违反 fail-closed。
 */
export const HELPER_ADDON_ENV = "ACODE_CUA_HELPER_ADDON";

/**
 * IPC error 消息封闭枚举（§2.7 封闭表，实现不得新增；新增须先改 spec）。
 * 全部为稳定字面量、零插值——结构上排除窗口标题/元素名/文本内容/路径/凭据
 * 进入宿主日志（§3.2 红线；该 message 会经 helper-reported-error 通路进宿主日志）。
 */
export type HelperFailureMessage =
  | "invalid-helper-arguments"
  | "unsupported-platform"
  | "transport-bind-failed"
  | "internal-helper-failure"
  | "native-addon-env-missing"
  | "native-addon-load-failed";

/** 无 IPC 通道（非 fork 启动）时的 stderr 字面量（§2.7：无法发 IPC，stderr 同名 + exit 1）。 */
export const MISSING_IPC_CHANNEL_MESSAGE = "missing-ipc-channel";

/** 各失败类别的退出码（§2.7 封闭表：配置/环境类 1；addon 缺失/加载失败 2 = C12 语义）。 */
export const EXIT_CODE_BY_FAILURE: Readonly<Record<HelperFailureMessage, 1 | 2>> = Object.freeze({
  "invalid-helper-arguments": 1,
  "unsupported-platform": 1,
  "transport-bind-failed": 1,
  "internal-helper-failure": 1,
  "native-addon-env-missing": 2,
  "native-addon-load-failed": 2,
});

/** 两阶段就绪消息（§2.2）：宿主 parseReadyMessage 校验 protocol/socketPath 非空串/pid 正整数。 */
export interface HelperReadyControlMessage {
  protocol: typeof CONTROL_PROTOCOL;
  type: "transport_ready" | "ready";
  socketPath: string;
  pid: number;
}

/** Helper 自报启动失败（§2.2 error 消息；message 只允许封闭字面量）。 */
export interface HelperErrorControlMessage {
  protocol: typeof CONTROL_PROTOCOL;
  type: "error";
  message: HelperFailureMessage;
}

/**
 * transport_ready：named pipe 已 bind、功能层未就绪（§2.2）。
 * socketPath 必须是 argv --socket 原值回显（宿主对不等值静默忽略该消息），
 * pid 必须是自身 process.pid（宿主对不等值 fail ready-pid-mismatch）。
 */
export function transportReadyMessage(socketPath: string, pid: number): HelperReadyControlMessage {
  return { protocol: CONTROL_PROTOCOL, type: "transport_ready", socketPath, pid };
}

/** ready：功能层就绪、可受理 health 探测（§2.2）。宿主收到后发起 broker_info healthProbe。 */
export function readyMessage(socketPath: string, pid: number): HelperReadyControlMessage {
  return { protocol: CONTROL_PROTOCOL, type: "ready", socketPath, pid };
}

/** error：自报启动失败（§2.2/§2.7），message 恒为封闭字面量、零插值。 */
export function errorControlMessage(message: HelperFailureMessage): HelperErrorControlMessage {
  return { protocol: CONTROL_PROTOCOL, type: "error", message };
}

/**
 * 入站 shutdown 判定（§2.2）：宿主经 IPC 发 { protocol, type: "shutdown" }，收到即进 STOPPING。
 * 其它入站消息（协议不符或未知 type）一律忽略——与宿主 parseReadyMessage 对未知 type
 * 返回 "ignore" 的前向兼容语义对称。
 */
export function isShutdownMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const value = message as Record<string, unknown>;
  return value.protocol === CONTROL_PROTOCOL && value.type === "shutdown";
}
