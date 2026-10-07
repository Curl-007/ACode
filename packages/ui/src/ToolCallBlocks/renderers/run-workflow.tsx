import { Workflow } from "lucide-react";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

/**
 * RunWorkflow（脚本工作流）的聊天卡。
 *
 * 为什么它必须有自己的一张卡，而不是走 `workflow` family 的兜底：那个兜底是 CreateWorkflow 卡
 * （`resolveRenderer.ts` 的 family 分支除 `submit_result` 外一律走它），会画出因果图、
 * dwf run 投影与 Refine 选项——脚本工作流**一个都没有**（它没有静态分析，run 也不在
 * `workflowRuns` 投影里，而在 `workflow_activity` 表）。一张长着别人器官的卡比一张朴素卡
 * 坏得多，所以这里按名认领，并且刻意**不**把 RunWorkflow 登记进 `tool-identity.ts` 的
 * workflow family（见 apps/acode-cli/specs/script-workflow-revival.md R3 补注）。
 *
 * 数据来源只有工具的入参与出参，不新增协议面：dwf 那些卡靠 `ToolResultDisplayPayload`
 * 与 run 投影驱动，而给这套系统加 display kind 等于往闭集枚举里塞值——那是破坏性偏斜，
 * 需要 capability 握手，不值得为一张卡付。入参 + 出参已经够回答用户真正会问的四件事：
 * 跑了哪个工作流、run 是什么状态、脚本在哪、启动回执说了什么。
 */
const RUN_WORKFLOW_TOOL_ICON = <Workflow className="size-4 shrink-0 text-foreground-subtle" />;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 脚本来源四态。用户批准的是「跑这段脚本」还是「跑那个存好的工作流」，是两件不同的事，
 * 卡上必须能看出来——否则一次按名字的调用会被读成一次现写脚本的调用。
 */
function resolveSourceKind(
  input: Record<string, unknown>,
): "scriptPath" | "script" | "name" | "resume" | undefined {
  // scriptPath 优先，与契约里「takes precedence over script and name」一致。
  if (readString(input.scriptPath)) return "scriptPath";
  if (readString(input.script)) return "script";
  if (readString(input.name)) return "name";
  if (readString(input.resumeFromRunId)) return "resume";
  return undefined;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="shrink-0 text-foreground-subtle">{label}</span>
      <span className="min-w-0 break-all font-mono text-foreground-muted">{value}</span>
    </div>
  );
}

export function RunWorkflowToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useACodeIntl();
  const { toolCall } = context.toolCallNode;

  const input = isPlainRecord(toolCall.input) ? toolCall.input : {};
  const output = isPlainRecord(toolCall.output) ? toolCall.output : undefined;

  const runId = readString(output?.runId);
  const name = readString(output?.name) ?? readString(input.name);
  const scriptPath = readString(output?.scriptPath) ?? readString(input.scriptPath);
  const response = readString(output?.response);
  const script = readString(input.script);
  const resumeFromRunId = readString(input.resumeFromRunId);
  // 出参缺席（还在跑、失败、或老会话快照没带 output）时退回入参，
  // 卡因此不会在启动的瞬间变成一片空白。
  const status = readString(output?.status);
  const sourceKind = resolveSourceKind(input);

  const kindLabel = intl.formatMessage({ id: "chat.toolCall.scriptWorkflow.label" });
  const kindDetail = intl.formatMessage({
    id: status === "completed"
      ? "chat.toolCall.scriptWorkflow.status.completed"
      : status === "failed"
        ? "chat.toolCall.scriptWorkflow.status.failed"
        : context.isRunning
          ? "chat.toolCall.scriptWorkflow.status.launching"
          : "chat.toolCall.scriptWorkflow.status.backgrounded",
  });
  const sourceLabel = sourceKind
    ? intl.formatMessage({ id: `chat.toolCall.scriptWorkflow.source.${sourceKind}` })
    : undefined;

  const snapshotNotice = (
    <ToolSnapshotFieldNotice
      refs={toolCall.snapshotRefs ?? []}
      onLoadFullToolCallFields={
        context.onLoadFullToolCallFields
          ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
          : undefined
      }
    />
  );

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      persistOpenKey="tool-call:run-workflow"
      icon={RUN_WORKFLOW_TOOL_ICON}
      kindLabel={kindLabel}
      kindDetail={kindDetail}
      {...(sourceLabel ? { sourceLabel } : {})}
      primaryText={name ?? runId ?? kindLabel}
      secondaryText={runId ? <span className="font-mono">{runId}</span> : undefined}
      statusLabel={context.statusLabel}
      isRunning={context.isRunning}
      showFailureStatus={status === "failed" || Boolean(toolCall.error)}
      content={
        <div className="flex flex-col gap-2">
          {runId ? (
            <Row
              label={intl.formatMessage({ id: "chat.toolCall.scriptWorkflow.field.runId" })}
              value={runId}
            />
          ) : null}
          {scriptPath ? (
            <Row
              label={intl.formatMessage({ id: "chat.toolCall.scriptWorkflow.field.scriptPath" })}
              value={scriptPath}
            />
          ) : null}
          {resumeFromRunId ? (
            <Row
              label={intl.formatMessage({
                id: "chat.toolCall.scriptWorkflow.field.resumeFromRunId",
              })}
              value={resumeFromRunId}
            />
          ) : null}
          {response ? (
            <p className="text-xs whitespace-pre-wrap text-foreground-muted">{response}</p>
          ) : null}
          {script ? (
            <details className="rounded-md border border-border-subtle">
              <summary className="cursor-pointer px-2 py-1 text-xs text-foreground-subtle">
                {intl.formatMessage({ id: "chat.toolCall.scriptWorkflow.field.script" })}
              </summary>
              <pre className="max-h-72 overflow-auto px-2 pb-2 text-xs font-mono whitespace-pre-wrap text-foreground-muted">
                {script}
              </pre>
            </details>
          ) : null}
          {toolCall.error ? (
            <p className="text-xs whitespace-pre-wrap text-danger">{toolCall.error}</p>
          ) : null}
          {snapshotNotice}
        </div>
      }
    />
  );
}
