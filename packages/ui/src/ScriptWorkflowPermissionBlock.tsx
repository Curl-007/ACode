import { Workflow } from "lucide-react";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { isPlainRecord, readRawToolCallInput } from "@/ToolCallBlocks/fileSummaryTypes.js";
import type { ACodePermissionRequest } from "@acode/shared";

/**
 * RunWorkflow（脚本工作流）的确认块。
 *
 * 为什么必须有它，而不是让 RunWorkflow 落到通用 fallback：fallback 会把整包 toolCall JSON
 * 摊开（`PermissionDialog.tsx` 里 MCP 与 WebFetch 两条注释记录的就是同一个坏法，两处都专门
 * 修过）。而 RunWorkflow 是 `alwaysAsk`——脚本是模型写的、用户在批准前**必须能读**，
 * 这正是 spec R4 把「沙箱没有全关、真正的控制是确认门」这句话成立的前提。一个把脚本
 * 渲染成 raw JSON 转义串的确认窗，等于那道控制形同虚设。
 *
 * 与聊天卡（`ToolCallBlocks/renderers/run-workflow.tsx`）的一处刻意差别：那边脚本放在
 * 可折叠的 `<details>` 里，这边**不折叠**。确认窗的既有纪律是「不提供收起/展开交互，
 * 避免用户把关键内容藏起来」，而脚本就是这个请求里唯一关键的内容；长脚本用段内滚动
 * 承接（同 justification 段的 max-h 哲学），不用折叠承接。
 */

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-ui-small">
      <span className="shrink-0 text-foreground-subtle">{label}</span>
      <span className="min-w-0 break-all font-mono text-foreground-muted">{value}</span>
    </div>
  );
}

export function ScriptWorkflowPermissionBlock({ request }: { request: ACodePermissionRequest }) {
  const { intl } = useACodeIntl();
  const input = readRawToolCallInput(request.raw);
  const fields = isPlainRecord(input) ? input : {};

  const script = readString(fields.script);
  const scriptPath = readString(fields.scriptPath);
  const name = readString(fields.name);
  const resumeFromRunId = readString(fields.resumeFromRunId);
  // scriptPath 优先，与契约的 "takes precedence over script and name" 一致。
  const sourceLabel = intl.formatMessage({
    id: scriptPath
      ? "chat.permission.scriptWorkflow.source.scriptPath"
      : script
        ? "chat.permission.scriptWorkflow.source.script"
        : name
          ? "chat.permission.scriptWorkflow.source.name"
          : resumeFromRunId
            ? "chat.permission.scriptWorkflow.source.resume"
            : "chat.permission.scriptWorkflow.source.unknown",
  });

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Workflow className="size-4 shrink-0 text-foreground-subtle" />
        <p className="text-ui-base font-medium leading-tight text-foreground">
          {intl.formatMessage({ id: "chat.permission.scriptWorkflow.title" })}
        </p>
      </div>

      <div className="space-y-1 rounded-xl border border-border bg-hover/50 px-3 py-2">
        <Field
          label={intl.formatMessage({ id: "chat.permission.scriptWorkflow.field.source" })}
          value={sourceLabel}
        />
        {name ? (
          <Field
            label={intl.formatMessage({ id: "chat.permission.scriptWorkflow.field.name" })}
            value={name}
          />
        ) : null}
        {scriptPath ? (
          <Field
            label={intl.formatMessage({ id: "chat.permission.scriptWorkflow.field.scriptPath" })}
            value={scriptPath}
          />
        ) : null}
        {resumeFromRunId ? (
          <Field
            label={intl.formatMessage({
              id: "chat.permission.scriptWorkflow.field.resumeFromRunId",
            })}
            value={resumeFromRunId}
          />
        ) : null}
      </div>

      {script ? (
        <div className="space-y-1">
          <p className="text-ui-small text-foreground-subtle">
            {intl.formatMessage({ id: "chat.permission.scriptWorkflow.scriptHeading" })}
          </p>
          <pre
            data-script-workflow-script="true"
            className="max-h-72 overflow-auto rounded-xl border border-border bg-hover/30 px-3 py-2 text-ui-small font-mono whitespace-pre-wrap text-foreground-muted"
          >
            {script}
          </pre>
        </div>
      ) : null}

      {/* 按 scriptPath 跑时，批准的是那个文件当前的字节。这一点必须说出来：文件在批准之后
          随时可能被改（手改、git pull、别人提交），而 RunWorkflow 每次都会重读它。
          dwf 的 alwaysAsk 注释里论证过同一件事——「上次批准过」推不出「这次跑的是同一段代码」。 */}
      {scriptPath && !script ? (
        <p className="text-ui-small text-foreground-subtle">
          {intl.formatMessage({ id: "chat.permission.scriptWorkflow.scriptPathNotice" })}
        </p>
      ) : null}
    </div>
  );
}
