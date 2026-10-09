// session 面的中立类型落点：session.ts 与 client.ts 共同引用。
// 拆分约束（纳管后 forbidCycles 生效）：此前 session.ts 反向 `import type
// AcodeHarnessClient from "./client.js"`，与 client.ts → session.ts 构成循环；
// 这里用依赖倒置消除——session 只依赖本文件的最小端口 SessionClientPort，
// AcodeHarnessClient 以结构化子类型满足端口，运行时行为不变。

import type { HarnessEvent, HarnessModelSelection } from "@acode/shared/harness-api";

export interface CreateSessionInput {
  cwd: string;
  systemPrompt?: string;
  model?: HarnessModelSelection;
  mode?: string;
  toolDenylist?: string[];
  workspaceIdentity?: string;
}

export interface SessionRunOptions {
  model?: HarnessModelSelection;
  toolDenylist?: string[];
}

export interface CustomToolSpec {
  name: string;
  description?: string;
  schema?: Record<string, unknown>;
  /** v1：自定义工具执行回调——服务端 configure_tools 尚未支持，注册时如实抛 not_supported。 */
  execute?: (input: unknown) => Promise<unknown>;
}

export interface ConfigureToolsInput {
  disable?: string[];
  custom?: CustomToolSpec[];
}

/**
 * HarnessSession 所需 client 能力的最小接口（依赖倒置的端口面）。
 * client.ts 不需要显式 implements——AcodeHarnessClient 的同名方法结构化满足；
 * 端口参数刻意收敛（unregisterSession 收 object），避免反向引用 HarnessSession 类型。
 */
export interface SessionClientPort {
  /** 内部：session 面复用的请求通道（client.request 同名透传）。 */
  request(method: string, params?: unknown): Promise<unknown>;
  /** 订阅连接层事件帧（返回移除句柄；session 构造/关闭时成对使用）。 */
  addEventListener(
    listener: (frame: { sessionId: string; seq: number; event: HarnessEvent }) => void,
  ): () => void;
  /** session.close() 时从 client 活跃登记表摘除；登记只按对象身份增删，不读取 session 成员。 */
  unregisterSession(session: object): void;
}
