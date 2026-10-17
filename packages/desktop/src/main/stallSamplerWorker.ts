// stall-sampler worker entry（specs/main-stall-diagnostics.md）。
// tsup 独立 entry（main/stallSamplerWorker），main 侧经 new Worker(new URL(...)) 拉起。
//
// 档位①（可行性实验实证，spec「可行性判决」）：同进程 worker_threads 内
// node:inspector/promises 的 Session.connectToMainThread() 在 Electron main 可用，
// 且主线程同步阻塞期间 Profiler.start 能落定。inspector 路线任一环节失败即降级
// heartbeat_only（档位④）：停跳检测、睡眠分类、时长上报、令牌桶照常（spec R8）。
import { Session } from "node:inspector/promises";
import { parentPort, workerData } from "node:worker_threads";
import { createStallSamplerCore, type StallSamplerProfilerPort } from "./stallSamplerCore.js";
import type { MainStallSamplerMode, MainStallSamplerWorkerData } from "./stallSamplerProtocol.js";

type InspectorSession = Pick<Session, "connectToMainThread" | "post">;

/**
 * 构造连到主线程的 inspector profiler 端口；任何一步失败返回 null（附原因），
 * 调用方降级 heartbeat_only。Profiler.enable/setSamplingInterval 懒执行 + memoize：
 * 常驻期不付 profiler 成本，首次 capture 才建链；enable 失败清空 memo 允许重试。
 */
function connectMainThreadProfiler(samplingIntervalUs: number): {
  profiler: StallSamplerProfilerPort | null;
  reason?: string;
} {
  let session: InspectorSession;
  try {
    session = new Session();
    session.connectToMainThread();
  } catch (error) {
    return {
      profiler: null,
      reason: `connect: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let enablePromise: Promise<void> | null = null;
  const ensureEnabled = (): Promise<void> => {
    enablePromise ??= (async () => {
      await session.post("Profiler.enable");
      await session.post("Profiler.setSamplingInterval", { interval: samplingIntervalUs });
    })().catch((error: unknown) => {
      enablePromise = null;
      throw error;
    });
    return enablePromise;
  };
  return {
    profiler: {
      async start() {
        await ensureEnabled();
        await session.post("Profiler.start");
      },
      async stop() {
        const result = await session.post("Profiler.stop");
        // Profiler.StopReturnType.profile 与本仓最小结构面兼容（nodes/samples）。
        return result.profile;
      },
    },
  };
}

function main(): void {
  const data = workerData as Partial<MainStallSamplerWorkerData> | null;
  const config = data?.config;
  if (!parentPort || !data?.heartbeat || !config) {
    // 只应由 stallSampler.ts 以完整 workerData 拉起；直接运行时安静退出。
    return;
  }
  const port = parentPort;
  const { profiler, reason } = connectMainThreadProfiler(config.samplingIntervalUs);
  const mode: MainStallSamplerMode = profiler ? "profiling" : "heartbeat_only";
  port.postMessage({ type: "sampler_ready", mode, ...(reason ? { reason } : {}) });

  const core = createStallSamplerCore({
    heartbeat: new BigInt64Array(data.heartbeat),
    profiler,
    post: (message) => port.postMessage(message),
    now: () => performance.now(),
    wallNow: () => Date.now(),
    config,
  });
  // 生命周期实证坑（spec「可行性判决」）：pending 的 inspector promise 不保 worker
  // 事件循环——本 interval 是 worker 常驻的唯一 ref'd handle，进程生命周期内不清除；
  // 最终 stall_report 发出前退出会丢报告（首轮实验以 code 0 退出复现过）。
  // 退出收敛由 main 侧 stop() 的 worker.terminate() 负责。
  setInterval(() => core.poll(), config.pollIntervalMs);
}

main();
