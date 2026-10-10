// 编译校验的消费示例（架构 context 阅读包展示；模型函数全部纯计算——无 IO、
// 无网络、无文件）：演示 contract.ts 公开面的典型用法，输入取自预置剖面数据。
import {
  buildTraceTree,
  collectStats,
  evaluate,
  profiles,
  userCandidates,
  type Candidate,
  type Decision,
  type ProductContext,
  type TraceStats,
} from "./contract.js";

/** 裁决入口：evaluate 是纯函数裁决表，同一 (context, candidate) 恒得同一结果。 */
export function exampleEvaluate(context: ProductContext, candidate: Candidate): Decision {
  return evaluate(context, candidate);
}

/** running 阶段收到「继续发送文字」：held 输入不静默入队，由用户二选一。 */
export function exampleRunningSendText(): Decision | undefined {
  const profile = profiles.find((item) => item.id === "running");
  const candidate = userCandidates.find((item) => item.id === "sendText");
  if (!profile || !candidate) return undefined;
  return evaluate(profile.context, candidate);
}

/** trace 树：buildTraceTree 内部先 resetIds，节点编号确定；collectStats 汇总。 */
export function exampleTraceStats(): TraceStats {
  const profile = profiles.find((item) => item.id === "running");
  if (!profile) throw new Error("missing running profile");
  return collectStats(buildTraceTree(profile.context, 8));
}
