// 中立的 agent RPC 客户端**接口**叶子（与具体传输实现解耦）。
//
// 为什么存在：`independentPlanSupport.ts` / `pluginReferenceCatalogRequest.ts` 只需要
// 「能发请求的客户端」这一能力，却 `import type { ACodeProtocolClient }` 依赖了**具体传输类**
// （AGENTS.md：调用方不应依赖被调用模块的内部实现）。而 `ACodeProtocolClient` 是 legacy 与 v4
// **共用**的版本无关载体（`acodeProtocolClient.ts:19` 方法名联合已含 `V4Method`；
// `acode-protocol-v4/transport.ts:370` 明写旧协议删除后它就是唯一协议面），M2/M4 之后它会**长期存在**，
// 名字里的「Protocol」也与「legacy 退役」无关。故把消费方需要的能力抽成中立接口，消费方依赖接口、
// 不依赖具体类；具体类 `implements` 本接口以防签名漂移。
//
// 纯类型叶子：无运行时代码、无 IO、不引入依赖方向变化（只被 services 内部 type-only 引用）。
import type {
  ACodeProtocolRequestId,
  ACodeProtocolTrace,
  LegacySurvivorMethod,
} from "@acode/shared";
import type { V4Method } from "@acode/shared/acode-protocol-v4";
import type { z } from "zod";

/** 客户端可发的方法名联合（与 acodeProtocolClient.ts 的同名 type 逐字一致，单一事实靠 implements 钉住）。 */
export type ACodeAgentRpcMethod = LegacySurvivorMethod | V4Method;

/** 请求选项（结构等价于 acodeProtocolClient.ts 的 ACodeProtocolClientRequestOptions）。 */
export interface ACodeAgentRpcRequestOptions {
  /** 观测不得参与 runtime 健康判定或业务空闲续期；默认保持业务请求语义。 */
  lifecycle?: "operation" | "observation";
  signal?: AbortSignal;
  trace?: ACodeProtocolTrace;
  timeoutMs?: number;
}

/**
 * agent RPC 客户端的中立能力面。消费方按 `Pick<ACodeAgentRpcClient, "request">` 等取用，
 * 不依赖具体传输类。`ACodeProtocolClient` 实现本接口（见其 class 声明）。
 */
export interface ACodeAgentRpcClient {
  request<T = unknown>(
    method: ACodeAgentRpcMethod,
    params?: unknown,
    resultSchema?: z.ZodType<T>,
    options?: ACodeAgentRpcRequestOptions,
  ): Promise<T>;
  respondError(
    id: ACodeProtocolRequestId,
    error: { code: number; message: string; data?: unknown },
  ): Promise<void>;
}
