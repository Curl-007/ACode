import { useCallback, useEffect, useState } from "react";
import { FolderOpenIcon, SaveIcon } from "lucide-react";
import { PROTOCOL_V4_LIMITS } from "@acode/shared/acode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { getPathLeaf } from "@/lib/path.js";
import type { WorkflowRunArtifactView } from "@/hooks/useWorkflowRunArtifacts.js";

/**
 * 内容产物的「保存为文件」动作（packages/desktop/specs/workflow-artifact-materialization.md）。
 *
 * 从 `WorkflowArtifactSidePane.tsx` 拆出（oxlint max-lines 400 门，与 WorkflowArtifactCards
 * 同一先例）：renderer 已按 version 分块读齐的字节（`useWorkflowRunArtifactBytes` 就是那条
 * `workflowRunArtifactRead` 调用面）整包下沉给 desktop main 落盘，返回本地路径。
 *
 * 门控三条：平台方法缺席（Web）⇒ 按钮整块隐藏；字节未就绪 ⇒ 禁用；
 * > `PROTOCOL_V4_LIMITS.attachmentMaxBytes`（20 MiB）⇒ 禁用 + tooLarge 提示（读链上界
 * 同源，这里是落盘前的双保险）。成功后留一行 savedAsFile（路径）+「在文件夹中显示」
 * （复用既有 openInFileManager）。
 */

/**
 * 落盘文件名：`sourcePath` 的叶子优先（那是作者起的名字），否则标题/id；markdown 与文本
 * 补回扩展名——main 侧的路径清洗（保留名、穿越、控制字符）不在 renderer 重复，这里只保证
 * **有**一个像样的名字。
 */
function materializeArtifactFileName(artifact: WorkflowRunArtifactView): string {
  const fromPath = artifact.sourcePath !== undefined ? getPathLeaf(artifact.sourcePath) : "";
  const base = fromPath.trim() || artifact.title?.trim() || artifact.id;
  if (base.includes(".")) return base;
  const contentType = artifact.contentType;
  if (artifact.kind === "markdown" || contentType === "text/markdown") return `${base}.md`;
  if (contentType === "application/json") return `${base}.json`;
  if (contentType !== undefined && contentType.startsWith("text/")) return `${base}.txt`;
  return base;
}

export function WorkflowArtifactSaveAsFile({
  artifact,
  bytes,
  runId,
  version,
}: {
  artifact: WorkflowRunArtifactView;
  /** 当前版本的分块拼接结果；null = 还在读（按钮禁用）。 */
  bytes: Uint8Array<ArrayBuffer> | null;
  runId: string;
  version: number;
}) {
  const { intl } = useACodeIntl();
  const platform = usePlatform();
  const materialize = platform.materializeWorkflowArtifactFile;
  const oversize = bytes !== null && bytes.length > PROTOCOL_V4_LIMITS.attachmentMaxBytes;
  const [saving, setSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);

  useEffect(() => {
    // 换产物或换版本后旧的成功/失败提示不再适用；落盘文件是版本快照，路径属于那一版。
    setSavedPath(null);
    setSaveFailed(false);
  }, [artifact.id, version]);

  const handleSaveAsFile = useCallback(() => {
    if (materialize === undefined || bytes === null || oversize) return;
    setSaving(true);
    setSaveFailed(false);
    materialize({
      runId,
      artifactId: artifact.id,
      version,
      fileName: materializeArtifactFileName(artifact),
      data: bytes,
    })
      .then((result) => {
        if ("localPath" in result) {
          setSavedPath(result.localPath);
          return;
        }
        setSaveFailed(true);
        logger.warn("[workflow-artifacts] 物化产物失败", {
          artifactId: artifact.id,
          error: result.error,
          runId,
          version,
        });
      })
      .catch((error) => {
        setSaveFailed(true);
        logger.warn("[workflow-artifacts] 物化产物失败", {
          artifactId: artifact.id,
          error: error instanceof Error ? error.message : String(error),
          runId,
          version,
        });
      })
      .finally(() => setSaving(false));
  }, [artifact, bytes, materialize, oversize, runId, version]);

  if (materialize === undefined) return null;
  return (
    <>
      <Button
        data-testid="workflow-artifact-save-as-file"
        disabled={saving || bytes === null || oversize}
        onClick={handleSaveAsFile}
        size="sm"
        type="button"
        variant="ghost"
      >
        <SaveIcon aria-hidden="true" className="size-3.5" />
        {intl.formatMessage({ id: "chat.toolCall.workflow.artifact.saveAsFile" })}
      </Button>
      {oversize ? (
        <p
          className="mt-1.5 w-full text-ui-sm text-warning"
          data-testid="workflow-artifact-too-large"
        >
          {intl.formatMessage({ id: "chat.toolCall.workflow.artifact.tooLarge" })}
        </p>
      ) : null}
      {savedPath !== null ? (
        <div
          className="mt-1.5 flex w-full flex-wrap items-center gap-2"
          data-testid="workflow-artifact-saved"
        >
          <span
            className="min-w-0 truncate font-mono text-ui-xs text-foreground-subtle"
            title={savedPath}
          >
            {intl.formatMessage(
              { id: "chat.toolCall.workflow.artifact.savedAsFile" },
              { path: savedPath },
            )}
          </span>
          <Button
            data-testid="workflow-artifact-show-in-folder"
            onClick={() => void platform.openInFileManager(savedPath)}
            size="xs"
            type="button"
            variant="ghost"
          >
            <FolderOpenIcon aria-hidden="true" className="size-3" />
            {intl.formatMessage({ id: "chat.toolCall.workflow.artifact.showInFolder" })}
          </Button>
        </div>
      ) : null}
      {saveFailed ? (
        <p
          className="mt-1.5 w-full text-ui-sm text-destructive"
          data-testid="workflow-artifact-save-failed"
        >
          {intl.formatMessage({ id: "chat.toolCall.workflow.artifact.saveFailed" })}
        </p>
      ) : null}
    </>
  );
}
