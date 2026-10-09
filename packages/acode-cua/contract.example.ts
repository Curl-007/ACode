/**
 * 契约示例：消费者如何以类型化方式使用 acode-cua 的 fail-closed 表面。
 *
 * 本文件是架构 context 阅读包的一部分（治理工件），不参与运行时与构建。
 * 要点：调用方永远不能假设 Computer Use 可用——运行时 execute 返回
 * isError 结果，PiP 客户端 send 返回 applied: false，谓词恒为 false。
 */
import type {
  ComputerUseRuntime,
  ComputerUseRuntimeExecuteInput,
  PipSessionClient,
  PipSessionEvent,
} from "./contract.js";

/** 执行一次 CUA 工具调用；占位构建中结果必然携带 isError: true。 */
export async function executeCuaTool(
  runtime: ComputerUseRuntime,
  input: ComputerUseRuntimeExecuteInput,
): Promise<unknown> {
  return runtime.execute(input);
}

/** 向 PiP 会话广播事件；占位构建中 applied 恒为 false（fail-closed）。 */
export async function sendPipSessionEvent(
  client: PipSessionClient,
  event: PipSessionEvent,
): Promise<boolean> {
  const result = await client.send(event);
  return result.applied;
}
