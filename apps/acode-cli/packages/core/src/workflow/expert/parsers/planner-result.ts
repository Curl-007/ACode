import {
  WorkflowGraphPlannerResultSchema,
  type WorkflowGraphPlannerResult,
} from "@acode/contracts";
import { normalizeWorkflowGraphSeedCandidate } from "./graph-seed.js";
import {
  isRecord,
  parsePlannerJson,
  readLooseArray,
  readLooseBoolean,
  readLooseStringArray,
  readLooseValue,
  stringValue,
} from "./json.js";

export function parseWorkflowPlannerResult(
  response: string,
  defaultPhase: string,
): WorkflowGraphPlannerResult {
  const raw = parsePlannerJson(response);
  // 对抗复核 F-1（specs/workflow-typed-artifacts.md R11）：空白节点 id 必须解析报错（fail-loud）。
  // schema 的 .trim().min(1) 会拒绝空白 id，但若不在此处显式拦截，direct 解析失败后会落入
  // 宽容 fallback（normalizeWorkflowGraphSeedCandidate），它按 seed 语义把空白 id 节点静默滤掉
  // ——「进图死路」变成「静默蒸发」，planner 白跑、扩张悄悄缩水。显式探测后抛错，错误沿既有
  // plannerRunner → collection-planner catch → planner_failed 事件通道可见（不新增事件枚举）。
  assertNoBlankPlannerNodeIds(raw);
  const direct = WorkflowGraphPlannerResultSchema.safeParse(raw);
  if (direct.success) return direct.data;
  if (!isRecord(raw)) {
    throw new Error("Workflow planner did not return JSON graph expansion data");
  }
  const seed = normalizeWorkflowGraphSeedCandidate(raw, defaultPhase);
  const collectionNodeIds =
    readLooseStringArray(raw, [
      "collectionNodeIds",
      "collection_node_ids",
      "collectionUpdates",
      "collection_updates",
    ]) ?? seed?.collections.flatMap((collection) => collection.nodeIds);
  const parsed = WorkflowGraphPlannerResultSchema.safeParse({
    collectionNodeIds,
    edges: seed?.edges ?? [],
    exhausted: readLooseBoolean(raw, ["exhausted"]),
    nodes: seed?.nodes ?? [],
    reasoning: stringValue(raw.reasoning),
  });
  if (parsed.success) return parsed.data;
  throw new Error("Workflow planner did not return JSON graph expansion data");
}

// 宽松节点数组键 / 宽松 id 键（与 graph-seed.ts 归一化键集一致）。只拦「键在场但值 trim 后
// 为空字符串」的形态——id 键整体缺失仍由宽容归一化按乱入 junk 丢弃（spec R11 边界）。
const PLANNER_NODE_ARRAY_KEYS = ["nodes", "newNodes", "new_nodes"];
const PLANNER_NODE_ID_KEYS = ["id", "name", "nodeName", "node_name"];

function assertNoBlankPlannerNodeIds(raw: unknown): void {
  const candidateArrays: unknown[][] = [];
  if (Array.isArray(raw)) {
    candidateArrays.push(raw);
  } else if (isRecord(raw)) {
    const nodes = readLooseArray(raw, PLANNER_NODE_ARRAY_KEYS);
    if (nodes) candidateArrays.push(nodes);
  }
  for (const nodes of candidateArrays) {
    for (const [index, node] of nodes.entries()) {
      if (!isRecord(node)) continue;
      const id = readLooseValue(node, PLANNER_NODE_ID_KEYS);
      if (typeof id === "string" && id.trim().length === 0) {
        throw new Error(
          `Workflow planner returned a blank node id at nodes[${index}] (expected a non-empty id after trimming; blank ids would defeat the critic gate's node-id audit)`,
        );
      }
    }
  }
}
