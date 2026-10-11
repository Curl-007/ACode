/**
 * engine.ts 的洞停靠半身（挖洞-填充，specs/workflow-holes.md）。方法体拆到本文件的
 * 自由函数、经 {@link EngineState} 接缝读写引擎状态——与 engine-settlement.ts /
 * engine-report.ts 同一条拆分纪律（oxlint max-lines 上限 400 行）。
 *
 * hole 与 ask 的关键差别：ask 的答案从 driver 回来（调度器管理生命周期），洞的"答案"是
 * **代码**，由主代理经 FillWorkflowHole 提交——而 fill 走 amend/supersede 链（resume 的
 * scriptHash 逐字节校验使原地改脚本不可行），所以本 run 的这次调用**永远不会兑现**：停靠
 * promise 挂到 run 结算，由 {@link EngineState.markSettled} 的撤下钩子以 Cancelled 拒绝
 * （同 withdrawSessionEscalations 先例：终态 run 按定义没有在等代码的人）。沙箱子进程随
 * harness 的收尾被 kill，脚本不会看到这次拒绝——同进程装配（测试）则会看到。
 */

import type { EngineState } from "./engine-state.js";
import { WorkflowError } from "./types.js";

/**
 * 停靠一个洞：铸 ordinal（实例身份进 nextOrdinal 体系，出生阶段由此被记录）、经 record()
 * 双轨发 `hole-reached`（journal dwf_event + driver.emit 扇出）、登记停驻 rejector。
 *
 * 顺序（载荷性）：先 record 再登记——journal 写不进去就没有 durable 的停靠记录，此时把
 * 调用挂成一个谁也看不见的停驻只会让脚本永久阻塞（escalation 桥接的 raise 路径同一条
 * 取舍）；record 抛错则没有登记，错误沿 host 调用冒回沙箱侧成为 run 失败。
 */
export function parkHole(
  state: EngineState,
  siteId: string,
  stage: string,
  prompt: string,
  askedAt: number,
): Promise<never> {
  if (state.isRunSettled()) return Promise.reject(state.runError());
  // 首达 ordinal：fill 是 supersede（本 run 的脚本不再被原地改动），这个 ordinal 因此同时
  // 是**唯一**的一次；它真正服务的是 resume 后的重新到达——确定性计数让两次到达拿到同一
  // 个 holeId，消费面（投影 reducer 的 upsert、FillWorkflowHole 的定位）据此幂等。
  const ordinal = state.nextOrdinal(siteId);
  const holeId = `${siteId}@${ordinal}`;
  state.record({ type: "hole-reached", holeId, siteId, ordinal, stage, prompt, askedAt });
  let reject!: (error: WorkflowError) => void;
  const promise = new Promise<never>((_resolve, rej) => {
    reject = rej;
  });
  state.parkedHoles.set(holeId, reject);
  return promise;
}

/**
 * 结算时撤下全部停驻中的洞：终态 run 按定义没有在等代码的人（fill 走 supersede 链、
 * 不回到这些调用），不撤下只会让同进程装配的脚本 await 永久悬挂——同
 * withdrawSessionEscalations 的先例（cancelAsk 拒掉停驻 deferred）。沙箱路径里子进程随
 * harness 收尾被 kill，脚本看不到这次拒绝。
 */
export function withdrawParkedHoles(
  parked: Map<string, (error: WorkflowError) => void>,
  failure: WorkflowError | undefined,
): void {
  if (parked.size === 0) return;
  const withdrawal =
    failure ?? new WorkflowError("Cancelled", "Run settled; holes parked on it were withdrawn along with it.");
  for (const reject of parked.values()) reject(withdrawal);
  parked.clear();
}
