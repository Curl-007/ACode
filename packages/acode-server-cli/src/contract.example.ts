// 编译校验的消费示例（架构 context 阅读包展示；不执行任何 IO——不 spawn、
// 不触网、不落盘、不读写真实 stdio）：CLI 的 IO 全部经 CliIO 注入，示例用
// 内存收集器代替；状态快照的构造与解析是纯 zod 计算。
import {
  SERVER_CLI_PROTOCOL_VERSION,
  createStoppedServerStatus,
  serverStatusSchema,
  type CliIO,
  type ServerStatus,
} from "./contract.js";

const collected: string[] = [];

/** CliIO 是 CLI 与宿主之间的唯一 IO 边界：stdout/stderr/confirm 全部可注入。 */
export const exampleIo: CliIO = {
  stdout: {
    write(value: string): void {
      collected.push(value);
    },
  },
  stderr: {
    write(value: string): void {
      collected.push(value);
    },
  },
  confirm: async () => "y",
};

/** stopped 快照：协议版本 + 崩溃预算 + coreHealth 的判别结构，构造是纯计算。 */
export function exampleStoppedStatus(): ServerStatus {
  return createStoppedServerStatus("1.2.3", { serviceRegistered: false, now: 0 });
}

/** 持久化状态回读必须过 zod 校验，不信任磁盘上的旧 JSON。 */
export function exampleParseStatus(json: unknown): ServerStatus {
  return serverStatusSchema.parse(json);
}

export function exampleProtocolVersion(): number {
  return SERVER_CLI_PROTOCOL_VERSION;
}
