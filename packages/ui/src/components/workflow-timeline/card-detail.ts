import type { WorkflowRunState } from "@acode/shared/acode-protocol-v4";

/**
 * 卡片细节串里「几个 X」那一段的措辞。
 *
 * 本仓的轻量 intl 没有 ICU 复数，所以单复数各自一个 key（`one` / `many`）。抽到这里是因为
 * 它同时被时间线那条路（`timeline-summary.ts`）与只吃投影的退化路
 * （{@link projectionOnlyCardDetail}）用：两条路必须说同一种话，措辞就只能有一份。
 */
export type FormatMessage = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

export function count(
  format: FormatMessage,
  one: string,
  many: string,
  value: number,
): string {
  return format({ id: value === 1 ? one : many }, { count: value.toLocaleString() });
}

/**
 * 只吃投影的表头细节串：阶段数 + 子代理数（+ 子代理模型名）。
 *
 * 为什么需要它：表头细节原本只有「有静态因果图 → 建得出时间线模型」一条路
 * （`workflowHeaderDetail`），建不出模型时整块缺席。脚本工作流不编译、不做静态分析，
 * **永远**没有图，于是对话里那张轮尾摘要卡上只剩一个状态词——连「几个阶段、几个子代理」
 * 都说不出来，而这些数字投影里一直都有。
 *
 * 段的选择与 `workflowHeaderDetail` 逐字对齐（卡上只说阶段与子代理，不说步数 / token /
 * 轮次 / 产物——那些留在详情页的摘要行），键也复用同一批。数字全部来自投影的计数字段，
 * 不做任何推断。
 *
 * 单独成模块而不是留在 `timeline-summary.ts` 里，是因为那个文件经
 * `subagent-model-label` 拖进了 SVG 资源导入，node 测试加载不了；纯规则要能被穷举单测。
 */
export function projectionOnlyCardDetail(
  format: FormatMessage,
  run: WorkflowRunState,
  subagentModelName?: string,
): string {
  const parts: string[] = [];
  const phases = run.phases?.length ?? 0;
  // 计数为零的那一段直接不出现——「0 phases」是噪音，不是信息。
  if (phases > 0) {
    parts.push(
      count(format, "chat.toolCall.workflow.card.phase", "chat.toolCall.workflow.card.phases", phases),
    );
  }
  // 跑着时数「工作中的」、结束后数总数：与有图那条路的 agentsPart 同一条规则。
  // 那一路是**无条件**出这一段的（0 个在工作中就说 0 个），所以这里也不加「大于零才出」的
  // 守卫——同一个 run 在两张卡上必须说同一句话，多一个条件就是多一处会漂移的分叉。
  const running = run.status === "pending" || run.status === "running";
  const agents = running
    ? run.actors.filter((actor) => actor.status === "running").length
    : run.actors.length;
  parts.push(
    running
      ? count(
          format,
          "chat.toolCall.workflow.card.agentWorking",
          "chat.toolCall.workflow.card.agentsWorking",
          agents,
        )
      : count(
          format,
          "chat.toolCall.workflow.card.agent",
          "chat.toolCall.workflow.card.agents",
          agents,
        ),
  );
  if (subagentModelName !== undefined) parts.push(subagentModelName);
  return parts.join(" · ");
}
