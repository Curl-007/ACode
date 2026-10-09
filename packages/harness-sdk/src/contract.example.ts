// 编译校验的消费示例（架构 context 阅读包展示；不执行任何 IO——不 spawn、不触网、
// 不落盘）：client 由宿主注入（declare），只演示 contract.ts 公开面的典型用法。
import { z } from "zod";
import type {
  AcodeHarnessClient,
  ConnectOptions,
  CreateSessionInput,
  HarnessSession,
} from "./contract.js";

declare const client: AcodeHarnessClient;

/** connect 模式的选项形态（launch 模式对应 AcodeHarnessClient.launch(LaunchOptions)）。 */
export const exampleConnectOptions = {
  transport: "stdio",
  command: "node",
  args: ["--import", "tsx", "packages/server/src/entry-harness.ts"],
} satisfies ConnectOptions;

/** 典型回合：建会话 → run 阻塞取 TurnResult → 关闭会话（示例不真正建连）。 */
export async function exampleRunTurn(prompt: string): Promise<string> {
  const input: CreateSessionInput = { cwd: "/tmp/example-workspace", mode: "build" };
  const session: HarnessSession = await client.createSession(input);
  try {
    const result = await session.run(prompt);
    return result.response ?? "";
  } finally {
    await session.close();
  }
}

/** 事件迭代：seq 单调帧流；break 退出时迭代器 return 路径真移除队列条目（M3）。 */
export async function exampleCollectText(session: HarnessSession): Promise<string> {
  let text = "";
  for await (const { event } of session.events()) {
    if (event.kind === "text_delta") text += event.delta ?? "";
    if (event.kind === "turn_done") break;
  }
  return text;
}

/** 结构化输出：zod schema 校验模型回复，违例自动带反馈重试（封顶后抛类型化错误）。 */
export async function exampleAskStructured(session: HarnessSession): Promise<{ answer: number }> {
  const schema = z.object({ answer: z.number() });
  return session.ask(schema, "Reply with a single JSON object.");
}

/** 权限应答：无应答超时=拒绝（fail-closed，spec R5）；主动应答会取消计时。 */
export async function exampleRespondPermission(
  session: HarnessSession,
  requestId: string,
  optionId: string,
): Promise<boolean> {
  const result = await session.respondPermission(requestId, optionId);
  return result.accepted;
}
