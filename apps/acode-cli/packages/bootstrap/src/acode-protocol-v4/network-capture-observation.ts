// ============================================================
// agent 进程内的网络观测（specs/runtime-network-capture.md 的采集半边）
// ============================================================
// 机制对照上游 zcode 3.15.1 的 RequestObservationStore/LocalRuntimeNetworkCapture：
// 进程内观测自身出站 HTTP，按 captureId 对账批量上报——不走 MITM 代理（避免与设置页
// 用户代理共用 env 键互相覆盖、避免 CA 注入）。
//
// 拦截点两处互斥分工：①global fetch 的进程级包装（plain 传输分支与模型网关 ai-sdk）；
// ②adapters http 客户端的自定义传输分支（代理 / 自定义 CA / public egress DNS 预检走
// node:http/https，绕过 global fetch）经 contracts 的 sink 注册表补记。
// install/uninstall 成对；关闭即还原原函数并卸 sink。
// Bash 等子进程的网络**不可见**（上游同样只标 processType:"cli"）——范围诚实边界。
//
// 相位归属：AsyncLocalStorage 上下文。已知调用面（模型执行 / WebFetch / WebSearch /
// MCP）在进入前 runWithNetworkCapturePhase 打标；未打标的出站请求归 "other"
// （不丢弃——观测面宁可多记一条诚实的 other，也不静默漏掉一次外联）。
//
// 脱敏纪律（写入侧执行，schema 是线上第二道闸）：不记 headers、不记 body；URL 剥
// userinfo；query 只保留参数名（值一律 <redacted>）。

import { currentNetworkCapturePhase, setNetworkCaptureObservationSink } from "@acode/contracts";
import type { NetworkCaptureRecord } from "@acode/shared/acode-protocol-v4";

/** URL 脱敏：剥 userinfo；query 值 → <redacted>（只留参数名）。非法 URL 原样截断。 */
export function sanitizeObservedUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl.slice(0, 2048);
  }
  url.username = "";
  url.password = "";
  const params = new URLSearchParams(url.search);
  // 直接迭代 keys()：set 只改既有键的值、不增删键，迭代器不会失效（无需快照拷贝）。
  for (const key of params.keys()) {
    params.set(key, "<redacted>");
  }
  url.search = params.toString();
  return url.toString().slice(0, 2048);
}

const METHOD_VOCABULARY = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

interface ObservationSink {
  captureId: string;
  emit: (records: NetworkCaptureRecord[]) => void;
}

const RING_CAPACITY = 500;
const BATCH_SIZE = 50;
const BATCH_INTERVAL_MS = 10_000;

let sink: ObservationSink | null = null;
let ring: NetworkCaptureRecord[] = [];
let batchTimer: ReturnType<typeof setInterval> | null = null;
let installedFetch: typeof globalThis.fetch | null = null;
let originalFetch: typeof globalThis.fetch | null = null;

function flushBatch(): void {
  if (!sink || ring.length === 0) return;
  const batch = ring.splice(0, BATCH_SIZE);
  // 环形缓冲只保留最近 RING_CAPACITY 条：flush 落后于产生时丢最旧的（观测是尽力而为）。
  if (ring.length > RING_CAPACITY) ring = ring.slice(ring.length - RING_CAPACITY);
  try {
    sink.emit(batch);
  } catch {
    // 上报失败不重试不缓存：live 事实，丢一批比堆内存安全。
  }
}

function recordFrom(
  method: string,
  url: string,
  status: number | null,
  startedAt: number,
  durationMs: number,
): NetworkCaptureRecord | null {
  const normalizedMethod = method.toUpperCase();
  if (!METHOD_VOCABULARY.has(normalizedMethod)) return null;
  return {
    startedAt,
    durationMs,
    method: normalizedMethod as NetworkCaptureRecord["method"],
    url: sanitizeObservedUrl(url),
    status,
    phase: currentNetworkCapturePhase() ?? "other",
  };
}

function pushRecord(record: NetworkCaptureRecord | null): void {
  if (!record || !sink) return;
  ring.push(record);
  if (ring.length > RING_CAPACITY) ring = ring.slice(ring.length - RING_CAPACITY);
  if (ring.length >= BATCH_SIZE) flushBatch();
}

function observedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const startedAt = Date.now();
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const method = init?.method ?? (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET");
  const finish = (status: number | null): void => {
    pushRecord(recordFrom(method, url, status, startedAt, Date.now() - startedAt));
  };
  const underlying = originalFetch;
  if (!underlying) return globalThis.fetch(input, init);
  return underlying(input, init).then(
    (response) => {
      finish(response.status);
      return response;
    },
    (error: unknown) => {
      finish(null);
      throw error;
    },
  );
}

/** 开启观测：包装 global fetch + 安装 adapters 补记 sink + 启动批量节奏。重复开启同一 captureId 是幂等 no-op。 */
export function installNetworkCaptureObservation(next: ObservationSink): void {
  if (sink?.captureId === next.captureId && installedFetch) return;
  uninstallNetworkCaptureObservation();
  sink = next;
  ring = [];
  originalFetch = globalThis.fetch.bind(globalThis);
  installedFetch = observedFetch;
  globalThis.fetch = observedFetch as typeof globalThis.fetch;
  // 自定义传输分支（node:http/https）绕过 global fetch：adapters 在分支点经 contracts
  // sink 补记，与这里的 fetch 包装互斥分工（2026-10-11 实机：WebFetch 行缺失的根因）。
  setNetworkCaptureObservationSink((input) => {
    pushRecord(recordFrom(input.method, input.url, input.status, input.startedAt, input.durationMs));
  });
  batchTimer = setInterval(flushBatch, BATCH_INTERVAL_MS);
  // 进程退出路径不被定时器吊住：观测是尽力而为的 live 面。
  batchTimer.unref?.();
}

/** 关闭观测：还原 fetch、卸 sink、清缓冲、停批量。幂等。 */
export function uninstallNetworkCaptureObservation(): void {
  if (batchTimer) {
    clearInterval(batchTimer);
    batchTimer = null;
  }
  if (installedFetch && originalFetch) {
    globalThis.fetch = originalFetch;
  }
  installedFetch = null;
  originalFetch = null;
  setNetworkCaptureObservationSink(null);
  ring = [];
  sink = null;
}

/** 当前是否在观测（gateway 的状态回读用）。 */
export function isNetworkCaptureObservationActive(): boolean {
  return sink !== null;
}

/** 仅供测试：立即冲刷当前缓冲（生产路径只按 50 条 / 10s 节奏批量）。 */
export function flushNetworkCaptureObservationForTest(): void {
  while (ring.length > 0) flushBatch();
}

/** 当前对账 id；未开启为 null。 */
export function activeNetworkCaptureId(): string | null {
  return sink?.captureId ?? null;
}
