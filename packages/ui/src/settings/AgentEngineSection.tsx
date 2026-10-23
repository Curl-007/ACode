import { CircleIcon, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_AGENT_ENGINE_SETTING,
  getAgentEngineDescriptors,
  type ACodeAgentEngineId,
} from "@acode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";

/**
 * 设置页「Agent 引擎」选择（spec: packages/shared/specs/agent-engine-jcode-slot.md R1/R2/R5/R7）。
 *
 * 与被删的旧 EngineSection 的关键区别：旧的是**只读展示**（永远显示「未安装」，因为三个
 * 外部槽位从未实现）；本组件是**可选择**的——引擎决定 Host spawn 哪个 agent
 * （glm → `acode.cjs app-server --stdio`；jcode → `acode.cjs jcode-bridge --stdio`）。
 *
 * 与 ToolSearchSection 同款「本机设置即真相」形态：选中态唯一来源是 props 传入的落盘值，
 * 无 Host 快照 store。写入经 updateSharedSettings 落盘，生效时机是**下一次 getClient**
 * （processManager 在复用既有进程前比对 engineId，不符即重启该 workspace 的 runtime，
 * 见 acodeAgentProcessManager.getClient）——故不需要提示重启 App，但切换瞬间会重启 agent。
 *
 * R2 诚实要求：jcode 后端**没有任何权限审批回路**（ACP 无 permission 方法、harness 桥
 * never emits permission_request、实测写文件零审批），所以选中 jcode 时必须常驻显示
 * 「无权限弹窗」警示——不得让用户以为选了 jcode 还有 ACode 的权限治理。
 */

/** jcode 引擎的 id 常量（避免在多处散落字面量）。 */
const JCODE_ENGINE_ID = "jcode";

export function AgentEngineSection({
  engine,
  jcodeBinaryPath,
  onSelectEngine,
  onChangeJcodeBinaryPath,
}: {
  /** 当前落盘引擎（已由调用方归一化；undefined 按缺省 native 回显）。选中态唯一来源。 */
  engine?: ACodeAgentEngineId | null;
  /** jcode 可执行文件路径（AppSettings.jcodeBinaryPath）。 */
  jcodeBinaryPath?: string | null;
  /** 改选引擎时的落盘动作。缺席 ⇒ 不可点（与 ToolSearchSection 同约定）。 */
  onSelectEngine?: (engine: ACodeAgentEngineId) => Promise<void>;
  /** 保存 jcode 路径的落盘动作。缺席 ⇒ 输入框只读。 */
  onChangeJcodeBinaryPath?: (path: string) => Promise<void>;
}) {
  const { intl } = useACodeIntl();
  const currentEngine = engine ?? DEFAULT_AGENT_ENGINE_SETTING;
  const descriptors = getAgentEngineDescriptors();

  return (
    <div className="space-y-3">
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.agentEngine.description" })}
      </p>
      <SettingsGroupCard>
        <div
          aria-label={intl.formatMessage({ id: "settings.agentEngine.title" })}
          className="flex flex-col gap-2 p-1"
          data-testid="settings-agent-engine-options"
          role="radiogroup"
        >
          {descriptors.map((descriptor) => {
            const selected = currentEngine === descriptor.id;
            return (
              <EngineOptionRow
                descriptorId={descriptor.id}
                key={descriptor.id}
                onSelect={onSelectEngine}
                selected={selected}
              />
            );
          })}
        </div>
      </SettingsGroupCard>

      {/* R2：jcode 无权限审批回路——选中时常驻警示，不随交互折叠。 */}
      {currentEngine === JCODE_ENGINE_ID ? (
        <p
          className="text-ui-base text-destructive"
          data-testid="settings-agent-engine-permission-warning"
          role="status"
        >
          {intl.formatMessage({ id: "settings.agentEngine.jcodePermissionWarning" })}
        </p>
      ) : null}

      {/* R5：jcode 二进制路径是**可选覆盖项**。shim 侧自动发现按 jcode 官方安装脚本
          默认落点（%LOCALAPPDATA%\jcode\bin / ~/.local/bin / /usr/local/bin）+ PATH 探测；
          桌面 GUI 的 PATH 不含 rc 条目，故默认落点探测是关键一层。仅非默认安装才需手填。 */}
      {currentEngine === JCODE_ENGINE_ID ? (
        <JcodeBinaryPathControl
          jcodeBinaryPath={jcodeBinaryPath}
          onChange={onChangeJcodeBinaryPath}
        />
      ) : null}
    </div>
  );
}

function EngineOptionRow({
  descriptorId,
  onSelect,
  selected,
}: {
  descriptorId: ACodeAgentEngineId;
  onSelect?: (engine: ACodeAgentEngineId) => Promise<void>;
  selected: boolean;
}) {
  const { intl } = useACodeIntl();
  const [saveError, setSaveError] = useState(false);
  const label = intl.formatMessage({ id: `engine.${descriptorId}.name` });
  const description = intl.formatMessage({ id: `engine.${descriptorId}.description` });

  const handleClick = useCallback(() => {
    if (onSelect === undefined || selected) return;
    setSaveError(false);
    onSelect(descriptorId)
      .then(() => setSaveError(false))
      .catch((error) => {
        // 保存失败只报状态，不改选中态：落盘值没变，UI 不能先假装变了。
        setSaveError(true);
        logger.warn("[agent-engine] 引擎选择保存失败", {
          error: error instanceof Error ? error.message : String(error),
          engine: descriptorId,
        });
      });
  }, [descriptorId, onSelect, selected]);

  return (
    <div className="flex flex-col">
      <button
        aria-checked={selected}
        aria-label={label}
        className={cn(
          "flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
          onSelect === undefined
            ? "cursor-default"
            : selected
              ? "cursor-default bg-selected"
              : "cursor-pointer hover:bg-hover",
        )}
        data-engine={descriptorId}
        data-selected={selected ? "true" : undefined}
        data-testid="settings-agent-engine-option"
        disabled={onSelect === undefined}
        onClick={handleClick}
        role="radio"
        type="button"
      >
        <CircleIcon
          aria-hidden
          className={cn(
            "mt-0.5 size-4 shrink-0 border",
            selected
              ? "border-primary fill-primary text-primary"
              : "border-border text-transparent",
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-ui-base font-medium text-foreground">{label}</span>
            {descriptorId === DEFAULT_AGENT_ENGINE_SETTING ? (
              <span className="rounded-full bg-surface px-1.5 py-px text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: "settings.agentEngine.defaultTag" })}
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block text-ui-base leading-4 text-foreground-subtle">
            {description}
          </span>
        </span>
      </button>
      {saveError ? (
        <p className="text-ui-base ml-9 text-destructive" role="alert">
          {intl.formatMessage({ id: "settings.agentEngine.saveError" })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * jcode 可执行文件路径输入（R5）。照 DataBaseDirControl 的 dirty/save 形态：
 * 本地草稿态 + 显式保存，避免每次击键都写盘并触发 agent 重启。
 * 清空后保存 = 归一为 undefined（normalizeSettingsPatch 支持 Reset）。
 */
function JcodeBinaryPathControl({
  jcodeBinaryPath,
  onChange,
}: {
  jcodeBinaryPath?: string | null;
  onChange?: (path: string) => Promise<void>;
}) {
  const { intl } = useACodeIntl();
  const effectivePath = jcodeBinaryPath ?? "";
  const [draft, setDraft] = useState(effectivePath);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    if (saveState !== "saved") {
      setDraft(effectivePath);
    }
  }, [effectivePath, saveState]);

  const isDirty = draft.trim() !== effectivePath;
  const isSaving = saveState === "saving";
  // 未填路径 = 走自动发现（shim 按安装脚本默认落点 + PATH 探测）；提示文案说明发现范围
  // 与何时需要手填，而非旧语义的「必填否则失败」。
  const isMissing = effectivePath.trim().length === 0 && saveState !== "saved";

  const handleSave = useCallback(async () => {
    if (onChange === undefined) return;
    setSaveState("saving");
    try {
      await onChange(draft.trim());
      setSaveState("saved");
    } catch (error) {
      setSaveState("error");
      logger.warn("[agent-engine] jcode 路径保存失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [draft, onChange]);

  return (
    <div className="flex flex-col gap-2">
      <label className="text-ui-base font-medium text-foreground" htmlFor="jcode-binary-path">
        {intl.formatMessage({ id: "settings.agentEngine.jcodeBinaryLabel" })}
      </label>
      <div className="flex items-center gap-2">
        <Input
          className="flex-1 font-mono"
          data-testid="settings-agent-engine-jcode-path-input"
          disabled={isSaving || onChange === undefined}
          id="jcode-binary-path"
          onChange={(event) => {
            setDraft(event.target.value);
            if (saveState !== "idle") setSaveState("idle");
          }}
          placeholder={intl.formatMessage({ id: "settings.agentEngine.jcodeBinaryPlaceholder" })}
          size="lg"
          spellCheck={false}
          value={draft}
        />
        <Button
          data-testid="settings-agent-engine-jcode-path-save"
          disabled={!isDirty || isSaving || onChange === undefined}
          onClick={() => void handleSave()}
          size="sm"
          type="button"
        >
          {isSaving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            intl.formatMessage({ id: "settings.agentEngine.jcodeBinarySave" })
          )}
        </Button>
      </div>
      {saveState === "error" ? (
        <p className="text-ui-base text-destructive" data-state="error" role="alert">
          {intl.formatMessage({ id: "settings.agentEngine.jcodeBinarySaveError" })}
        </p>
      ) : saveState === "saved" ? (
        <p className="text-ui-base text-foreground-subtle" data-state="saved">
          {intl.formatMessage({ id: "settings.agentEngine.jcodeBinarySaved" })}
        </p>
      ) : isMissing ? (
        <p className="text-ui-base text-amber-600 dark:text-amber-400" data-state="required">
          {intl.formatMessage({ id: "settings.agentEngine.jcodeBinaryRequired" })}
        </p>
      ) : null}
    </div>
  );
}
