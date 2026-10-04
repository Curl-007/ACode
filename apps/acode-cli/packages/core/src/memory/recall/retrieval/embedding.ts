// 机制参照 jcode (MIT) crates/jcode-base/src/embedding_backend.rs 的后端可插拔设计，
// 自撰 TypeScript 实现。产品规则见 apps/acode-cli/specs/memory-semantic-recall.md R4。

import type { Logger } from "@acode/contracts";

import { RETRIEVAL_CONSTANTS } from "./constants.js";

/**
 * dense embedding 后端接口（R4）。可插拔是刻意设计：默认路径必须本地
 * （零凭据依赖、离线可用）；OpenAI 兼容后端只留接口位不实现——外部 API 送记忆
 * 正文是数据外流面，将来做需走与 WebFetch 同级的 egress 声明（spec 未做 §3）。
 */
export interface EmbeddingBackend {
  /** 向量空间标签（见 EMBEDDING_MODEL_ID）：sidecar 的 model 守卫与它全等比较。 */
  readonly modelId: string;
  readonly dim: number;
  /** 失败抛出，由检索管线捕获并降级（R1：检索层 fail-open）。 */
  embed(texts: readonly string[]): Promise<number[][]>;
}

export interface LocalWasmEmbeddingBackendDeps {
  logger?: Logger;
}

/**
 * 本地 wasm embedding 后端的占位实现（Phase A 只落接口位）。
 *
 * Phase B 登记：transformers.js wasm 后端（all-MiniLM-L6-v2 的 ONNX int8 量化版，
 * 384 维），**明确不用原生模块**——onnxruntime-node 的 Electron ABI 重编译是发布链
 * 负担。引入 transformers.js/onnxruntime 依赖需独立决策（含 THIRD-PARTY-NOTICES.md
 * 登记、模型惰性下载带 sha256 校验、发布清单资产路径），不在本项内完成。
 *
 * 返回 `null` = 后端不可用：检索管线按 R1 fail-open 退回纯 BM25（Phase A only），
 * 注入协议行为不受影响。
 */
export async function createLocalWasmEmbeddingBackend(
  deps: LocalWasmEmbeddingBackendDeps = {},
): Promise<EmbeddingBackend | null> {
  deps.logger?.debug("Local wasm embedding backend not registered in this build", {
    event: "memory.recall.embedding_placeholder",
    model: RETRIEVAL_CONSTANTS.EMBEDDING_MODEL_ID,
    module: "core.memory",
  });
  return null;
}
