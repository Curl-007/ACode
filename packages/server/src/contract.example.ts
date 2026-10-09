// 编译校验的消费示例（架构 context 阅读包展示；不执行任何 IO——不监听端口、
// 不 spawn 远端进程、不建 SSH/WSL 连接）：backend/server 由宿主注入，只演示
// server contract.ts 公开面的典型用法。
import {
  buildPosixShellExecCommand,
  quotePosixShellArg,
  type HarnessApiServer,
  type IRemoteBackend,
  type RemoteConnectionProgressEvent,
  type RemoteEnvironment,
} from "./contract.js";

/** remote backend 只读探测：detect 不要求远端有 Node.js，返回 platform/arch。 */
export async function exampleDetectRemote(backend: IRemoteBackend): Promise<RemoteEnvironment> {
  return backend.detect();
}

/** 纯函数面：posix shell 引用/命令构造（desktop attachment 链路同款），无 IO。 */
export function exampleBuildRemoteExec(command: string, user: string): string {
  return buildPosixShellExecCommand(`${command} --user ${quotePosixShellArg(user)}`);
}

/** 连接进度事件：level 是三态封闭枚举，消费方按它投影，不解析 args 文本。 */
export function exampleIsProgressError(event: RemoteConnectionProgressEvent): boolean {
  return event.level === "error";
}

/** Harness 服务端生命周期：stop 幂等；done 在传输关闭后 resolve。 */
export async function exampleStopHarness(server: HarnessApiServer): Promise<void> {
  await server.stop();
  await server.done();
}
