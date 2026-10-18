import {
  CoreErrorType,
  createCoreError,
  getCurrentModelInvocationContext,
  runWithModelInvocationContext,
  type Model,
  type ModelInvocationContext,
  type ModelRequest,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeModelFactoryInput } from "../types.js";
import { resolveModelRetryBudgetFromTaskType } from "./model-request-session-type.js";
// WI-17（specs/transcript-secret-obfuscation.md R2）：出站密钥混淆的唯一收口。
import { getSecretRedactionService } from "../../security/secret-redaction/index.js";

export function createRuntimeModel(
  runtime: AgentRuntimeInternal,
  input: Omit<RuntimeModelFactoryInput, "selection"> & {
    selection: RuntimeModelFactoryInput["selection"] | undefined;
  },
): Model {
  // 未绑定 Session 可恢复历史；仅在执行入口拒绝缺失选择，Factory 契约仍严格。
  if (!input.selection) {
    throw createCoreError(CoreErrorType.ConfigurationError, "Select a model before continuing", {
      recoverable: true,
    });
  }
  return withSecretRedactionLayer(
    runtime,
    withRuntimeInvocationLayer(
      runtime,
      runtime.modelFactory({ ...input, selection: input.selection }),
    ),
  );
}

/**
 * 出站消息脱敏层（WI-17 唯一插点）。
 *
 * 为什么收口在这里：全部 runtime 侧 Model 句柄都诞生于 createRuntimeModel（turn /
 * compact / steering / sidecar / memory / 子代理 / 工具内部调用，见 spec 背景表），
 * 消息构造点分散但全部汇流进经此包装的 generateText/streamText 的 ModelRequest；
 * 它又位于 adapters 发送路径的上游，provider 前再无旁路。
 *
 * 边界：只投影 `request.messages`；tools（schema）、responseJsonSchema、options、
 * abortSignal 一律不动（红线：混淆绝不动工具 schema 等非用户数据面）。无命中或
 * 开关禁用时透传原 request 引用（identity，不破坏下游 === 恒等判断）。
 */
function withSecretRedactionLayer(runtime: AgentRuntimeInternal, model: Model): Model {
  const projectRequest = (request: ModelRequest): ModelRequest => {
    const service = getSecretRedactionService({
      warn: (message, details) => runtime.logger?.warn(message, details),
    });
    const messages = service.projectModelMessages(request.messages);
    return messages === request.messages ? request : { ...request, messages };
  };
  const wrapped: Model = {
    providerId: model.providerId,
    modelId: model.modelId,
    displayName: model.displayName,
    properties: model.properties,
    optionSpecs: model.optionSpecs,
    options: model.options,
    bind(options) {
      // bind 链必须保持脱敏层在场（sidecar 的 auxiliaryModelOptions bind 同款路径）。
      return withSecretRedactionLayer(runtime, model.bind(options));
    },
    generateText(request) {
      return model.generateText(projectRequest(request));
    },
    streamText(request) {
      // 同步投影后同步返回内层 iterable：不引入异步惰性，保住
      // runWithModelInvocationContext 的 ALS 作用域语义（spec R5 同步纪律同源）。
      return model.streamText(projectRequest(request));
    },
  };
  return Object.freeze(wrapped);
}

/**
 * runtime 层调用上下文。
 *
 * 准入端口与重试预算回答的是「谁在调」（这个 runtime 归哪个治理器管、允许多少次重试），不是
 * 「为什么调」（agent step / web_search / compact / title）。设计缺口：它们若只在 turn step
 * 的调用上下文里注入，WebSearch / WebFetch 处理 / 压缩 / 标题 sidecar 等九处只设「为什么调」的
 * 调用点全部绕过了闸门——实测场景下治理器看不见三分之二的 429。现在这两个字段在句柄
 * 工厂绑定一次；`withModelInvocationContext` 的合并顺序让本层压过调用层，没有逐调用退出口：
 * 想不受闸门约束的 runtime 本来就不带准入端口。
 */
function withRuntimeInvocationLayer(runtime: AgentRuntimeInternal, model: Model): Model {
  const layer: ModelInvocationContext = {
    modelRetryBudget: resolveModelRetryBudgetFromTaskType(runtime.config.taskType),
    ...(runtime.modelRequestAdmission === undefined
      ? {}
      : { modelRequestAdmission: runtime.modelRequestAdmission }),
  };
  return withModelInvocationContext(model, () => layer);
}

export function withModelInvocationContext(
  model: Model,
  createContext: (request: ModelRequest) => ModelInvocationContext,
): Model {
  const wrapped: Model = {
    providerId: model.providerId,
    modelId: model.modelId,
    displayName: model.displayName,
    properties: model.properties,
    optionSpecs: model.optionSpecs,
    options: model.options,
    bind(options) {
      return withModelInvocationContext(model.bind(options), createContext);
    },
    generateText(request) {
      return runWithModelInvocationContext(
        { ...getCurrentModelInvocationContext(), ...createContext(request) },
        () => model.generateText(request),
      );
    },
    streamText(request) {
      return runWithModelInvocationContext(
        { ...getCurrentModelInvocationContext(), ...createContext(request) },
        () => model.streamText(request),
      );
    },
  };
  return Object.freeze(wrapped);
}
