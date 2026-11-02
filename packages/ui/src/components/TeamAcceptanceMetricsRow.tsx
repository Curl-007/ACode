import { useACodeIntl } from "@/i18n/IntlProvider.js";
import type { ConversationStatusPanelTeam } from "@/v4/teamPanelModel.js";

/**
 * 验收度量行（R12）：一次验收通过率 / 平均尝试数 / 打回次数 / 平均验收耗时。
 *
 * 只读派生投影（EI-48）：不缓存、不落盘、不进写入路径。诚实性纪律：
 * - `metrics` 缺席（旧插件）→ **整行不渲染**（不显示 0 冒充）；
 * - 比率为 `null`（分母 0）→ 显示「样本不足」，**不得用 0 冒充无数据**（EI-9）；
 * - `latency.sampleSize === 0` → 耗时一律不显示；
 * - 不展示 `metrics.tasks.inReview`：待验收计数以 `counts.inReview` 为唯一显示源（附录 C OQ2）。
 *
 * 卡片状态行与状态面板摘要各调一次（不各写一遍）：两处共用本叶子的同一份判读。
 */
export function TeamAcceptanceMetricsRow({ team }: { team: ConversationStatusPanelTeam }) {
  const { intl } = useACodeIntl();
  const metrics = team.metrics;
  if (!metrics) return null;
  const format = (id: string, values: Record<string, string>) => intl.formatMessage({ id }, values);
  const insufficient = intl.formatMessage({ id: "chat.statusPanel.agentTeams.metricsInsufficient" });
  const { acceptance, latency } = metrics;
  return (
    <span
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-xs text-foreground-subtlest"
      data-testid="team-acceptance-metrics"
    >
      <span className="tabular-nums">
        {acceptance.firstPassRate === null
          ? format("chat.statusPanel.agentTeams.metricsFirstPassRate", { rate: insufficient })
          : format("chat.statusPanel.agentTeams.metricsFirstPassRate", {
              rate: `${Math.round(acceptance.firstPassRate * 100)}%`,
            })}
      </span>
      <span className="tabular-nums">
        {acceptance.avgAttemptsPerTask === null
          ? format("chat.statusPanel.agentTeams.metricsAvgAttempts", { count: insufficient })
          : format("chat.statusPanel.agentTeams.metricsAvgAttempts", {
              count: acceptance.avgAttemptsPerTask.toFixed(1),
            })}
      </span>
      <span className="tabular-nums">
        {format("chat.statusPanel.agentTeams.metricsRejections", {
          count: String(acceptance.rejections),
        })}
      </span>
      {latency.sampleSize > 0 && latency.avgAcceptLatencyMs !== null ? (
        <span className="tabular-nums">
          {format("chat.statusPanel.agentTeams.metricsAvgLatency", {
            seconds: (latency.avgAcceptLatencyMs / 1000).toFixed(1),
          })}
        </span>
      ) : null}
    </span>
  );
}