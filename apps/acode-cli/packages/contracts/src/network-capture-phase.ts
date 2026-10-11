// 网络观测的相位标注（specs/runtime-network-capture.md 的采集半边）。
//
// AsyncLocalStorage 上下文住在 contracts 而不是 bootstrap：打标点分散在 core 的工具
// handler（WebFetch/WebSearch）与 runtime 的模型执行步，而拦截器本体在 bootstrap——
// 依赖方向是 bootstrap → core → contracts，共享词汇只能落在最底层。
//
// 语义：已知调用面在进入前 runWithNetworkCapturePhase 打标，ALS 自动穿透其下的全部
// async fetch；未打标的出站请求由拦截器归 "other"（不丢弃——观测面宁可多记一条诚实
// 的 other，也不静默漏掉一次外联）。

import { AsyncLocalStorage } from "node:async_hooks";
import type { NetworkCaptureRecord } from "@acode/shared/acode-protocol-v4";

export type NetworkCapturePhase = NetworkCaptureRecord["phase"];

const networkCapturePhaseStorage = new AsyncLocalStorage<NetworkCapturePhase>();

/** 在已知调用面入口打标相位。 */
export function runWithNetworkCapturePhase<T>(phase: NetworkCapturePhase, fn: () => T): T {
  return networkCapturePhaseStorage.run(phase, fn);
}

/** 拦截器侧读取当前相位；未打标回 undefined（由拦截器归 "other"）。 */
export function currentNetworkCapturePhase(): NetworkCapturePhase | undefined {
  return networkCapturePhaseStorage.getStore();
}

// ------------------------------------------------------------
// 观测记录 sink 注册表
// ------------------------------------------------------------
// 与相位同层的原因一致：补记点分散在 adapters 的 http 客户端（自定义传输分支不走
// global fetch，进程级 fetch 包装看不见它），而环形缓冲与上报住在 bootstrap——
// 依赖方向 adapters → contracts ← bootstrap，共享出口只能落在最底层。
// 未安装 sink 时记录是 no-op（观测关闭即零开销）。

/** 一次出站 HTTP 的观测输入（URL 脱敏由安装方执行，adapters 交原始值）。 */
export interface NetworkCaptureObservationInput {
  method: string;
  url: string;
  status: number | null;
  startedAt: number;
  durationMs: number;
}

type NetworkCaptureObservationSink = (input: NetworkCaptureObservationInput) => void;

let observationSink: NetworkCaptureObservationSink | null = null;

/** 安装/卸载观测记录出口（bootstrap 的 install/uninstall 成对调用）。 */
export function setNetworkCaptureObservationSink(next: NetworkCaptureObservationSink | null): void {
  observationSink = next;
}

/** 补记一条观测；sink 缺席或安装方抛错都静默吞（观测是尽力而为的 live 面）。 */
export function recordNetworkCaptureObservation(input: NetworkCaptureObservationInput): void {
  const current = observationSink;
  if (!current) return;
  try {
    current(input);
  } catch {
    // 观测失败不能反噬业务请求。
  }
}
