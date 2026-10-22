import { useCallback, useMemo, useRef } from "react";
import {
  ACODE_AGENT_PROVIDER,
  DEFAULT_NEW_TASK_DEFAULTS,
  NEW_TASK_DEFAULT_MODE_IDS,
  getACodeAgentAvailableModes,
  normalizeNewTaskDefaultMode,
  type NewTaskDefaults,
} from "@acode/shared";
import {
  DEFAULT_REASONING_LEVEL_PICK_LEVELS,
  type DefaultReasoningLevelPick,
} from "@acode/provider";
import {
  ModelConfigSelect,
  type ModelSelectGroup,
  type ModelSelectGroupItem,
} from "@/ModelConfigSelect.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { getModeOptionDisplayLabel } from "@/chat-input-toolbar/display.js";
import { thoughtLevelLabelId } from "@/chat-input-toolbar/thoughtLevelOptions.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { readComposerRecent } from "@/lib/composerRecent.js";
import {
  buildRegistryModelSelectGroups,
  resolveModelDisplayName,
} from "@/lib/modelSelectionGroups.js";
import { splitModelTriggerLabelParts } from "@/v4/composer/modelTriggerDisplay.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/acodeCustomModelValue.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/** Radix Select 不接受空字符串值；用哨兵表示「跟随默认」。 */
const FOLLOW_DEFAULT_VALUE = "new-task-defaults:follow";
const MODEL_ITEM_NEVER_LOCKED = () => false;
/** 与 SettingsRow 的 260px 控件列对齐；Select 走 input variant，ModelConfigSelect 是 ghost 按钮需自带边框。 */
const SELECT_TRIGGER_CLASSNAME = "w-[260px] min-w-0 justify-between";
/** 模型行控件列经 controlLayout="model" 加宽；触发器按内容取宽、上限为列宽，让典型长度的模型 ID 单行看全。 */
const MODEL_TRIGGER_CLASSNAME =
  "max-w-full min-w-0 justify-between rounded-lg border border-input-border bg-input px-3 py-1.5 text-foreground hover:border-input-border-hover hover:bg-input focus-visible:border-input-border-focused focus-visible:bg-input-focused";
/**
 * truncate 挂在 flex 容器上不会对子元素生效（截断发生在 RollingToolbarLabel 内层），
 * 沿用 composer 的既有写法把 block+truncate 下推到内层 span，超长 ID 才出省略号而不是硬裁切。
 */
const MODEL_TRIGGER_LABEL_CLASSNAME =
  "inline-flex min-w-0 text-left [&>span]:max-w-full [&>span>span]:block [&>span>span]:truncate";

/**
 * 已固定但当前模型不支持的档位必须留在列表里：设置保留用户原意图（换回支持的模型即重新生效），
 * 而 Radix Select 找不到对应项时触发器会显示为空，看起来像设置丢了。
 */
function isDefaultReasoningLevelPick(value: string): value is DefaultReasoningLevelPick {
  return (
    value === "first" ||
    value === "highest" ||
    (DEFAULT_REASONING_LEVEL_PICK_LEVELS as readonly string[]).includes(value)
  );
}

function withStoredValue(values: readonly string[], stored: string | null): string[] {
  if (!stored || values.includes(stored)) return [...values];
  return [stored, ...values];
}

interface TaskDefaultsSectionProps {
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * 新建任务默认值：把权限模式 / 模型 / 推理强度固定成常态组合。
 *
 * 只写 `AppSettings.newTaskDefaults`（唯一持久化所有者），读取端在
 * `v4/composer/newTaskDraft.ts`；本组件不缓存第二份已确认状态，控件值直接来自设置快照。
 * 目标仓 ModelSelection 没有速度维度，本批不渲染速度行（见移植 spec §2.7）。
 */
export function TaskDefaultsSection({
  workspacePath,
  workspaceIdentity,
}: TaskDefaultsSectionProps) {
  const { intl } = useACodeIntl();
  const { settings, update } = useSettings();
  const localHostServices = useBaseWorkspaceServices();
  const modelSelectionRead = useModelSelectionServiceView(localHostServices.modelSelectionService);
  const view = modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  const defaults = settings?.newTaskDefaults ?? DEFAULT_NEW_TASK_DEFAULTS;
  // 修复原因：update 非乐观，快照回来前的第二次提交仍拿旧 defaults 做整份替换，会把第一次改动回滚。
  // 修复依据：在途提交按提交顺序累积到 ref；新快照到达（引用变化）即以服务端事实为准重新同步。
  const pendingDefaultsRef = useRef({ source: defaults, value: defaults });
  if (pendingDefaultsRef.current.source !== defaults) {
    pendingDefaultsRef.current = { source: defaults, value: defaults };
  }
  // 快照未到达时 `defaults` 是本地默认值；此时写入会把已固定的项静默清空，
  // 所以整个章节在读到持久化值之前保持不可交互。
  const settingsReady = settings?.newTaskDefaults !== undefined;
  const enabled = settingsReady && defaults.enabled;
  const followLabel = intl.formatMessage({ id: "settings.taskDefaults.followDefault" });

  const modelGroups = useMemo<ModelSelectGroup[]>(() => {
    if (!view) return [];
    return buildRegistryModelSelectGroups(ACODE_AGENT_PROVIDER, view, {
      startPlanBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.startPlanBadge",
      }),
      apiKeyLabel: intl.formatMessage({ id: "settings.modelProvider.apiKey" }),
      codingPlanLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.codingPlan",
      }),
    });
  }, [intl, view]);

  // ModelConfigSelect 是 memo 组件：内联数组每次渲染都是新引用，会让 memo 形同虚设。
  const modelLeadingItems = useMemo<ModelSelectGroupItem[]>(
    () => [{ key: "new-task-defaults-follow", value: FOLLOW_DEFAULT_VALUE, name: followLabel }],
    [followLabel],
  );

  // 档位选项来源与新建任务的真实解析同源：已固定模型 → 本 workspace 最近提交的模型 →
  // Host 首选 → 目录首个模型。用固定模型的档位表，用户才不会选到该模型不支持的值。
  const optionSourceModel = useMemo(() => {
    if (!view) return null;
    const seed =
      defaults.model ??
      readComposerRecent(workspacePath, workspaceIdentity)?.modelSelection ??
      view.preferredSelection ??
      null;
    const matched = seed
      ? view.providers
          .find((provider) => provider.providerId === seed.providerId)
          ?.models.find((model) => model.modelId === seed.modelId)
      : undefined;
    return matched ?? view.providers.flatMap((provider) => provider.models)[0] ?? null;
  }, [view, defaults.model, workspacePath, workspaceIdentity]);

  const reasoningValues = optionSourceModel?.config.optionSpecs.reasoningLevel.values ?? [];
  const reasoningOptions = withStoredValue(reasoningValues, defaults.reasoningLevel);
  const speedValues = optionSourceModel?.config.optionSpecs.speed?.values ?? [];
  const speedOptions = withStoredValue(speedValues, defaults.speed);
  const catalogReady = view !== null;

  const commit = useCallback(
    async (next: Partial<NewTaskDefaults>): Promise<void> => {
      try {
        // patch 按整份对象替换：每次都提交完整四项，避免半份 patch 把未提及的项清空。
        const merged = { ...pendingDefaultsRef.current.value, ...next };
        pendingDefaultsRef.current = { ...pendingDefaultsRef.current, value: merged };
        await update({ newTaskDefaults: merged });
      } catch (error) {
        // 设置写失败时控件会随下一次快照回退到真实值，这里只补一条可读原因。
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [update],
  );

  const modeLabel = useCallback(
    (value: string): string => {
      const mode = getACodeAgentAvailableModes().find((candidate) => candidate.id === value);
      return mode
        ? getModeOptionDisplayLabel(intl, ACODE_AGENT_PROVIDER, {
            value: mode.id,
            name: mode.name,
          })
        : value;
    },
    [intl],
  );

  const reasoningLabel = useCallback(
    (value: string): string => {
      const labelId = thoughtLevelLabelId(value);
      return labelId ? intl.formatMessage({ id: labelId }) : value;
    },
    [intl],
  );

  const speedLabel = useCallback(
    (value: string): string => {
      if (value === "fast") return intl.formatMessage({ id: "chat.toolbar.speed.fast" });
      if (value === "standard") return intl.formatMessage({ id: "chat.toolbar.speed.standard" });
      return value;
    },
    [intl],
  );

  const modelValue = defaults.model
    ? encodeCustomModelValue(defaults.model.providerId, defaults.model.modelId)
    : FOLLOW_DEFAULT_VALUE;
  const modelTriggerLabel = defaults.model?.modelId ?? followLabel;
  // 模型名就是原始 modelId（无 displayName 字段），长 ID 把 provider/网关前缀弱化显示，
  // 让视觉重心落在尾部模型名上；与 v4 composer 的前缀弱化形态一致。
  const modelTriggerParts = splitModelTriggerLabelParts(modelTriggerLabel);

  const handleModelValueChange = useCallback(
    (value: string): void => {
      if (value === FOLLOW_DEFAULT_VALUE) {
        void commit({ model: null });
        return;
      }
      const decoded = decodeCustomModelValue(value);
      if (!decoded) return;
      const modelName = decoded.modelName ?? resolveModelDisplayName(modelGroups, value);
      if (!modelName) return;
      void commit({
        model: { providerId: decoded.providerId, modelId: modelName },
      });
    },
    [commit, modelGroups],
  );

  return (
    <div className="space-y-4">
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.taskDefaults.reasoningPick" })}
          description={intl.formatMessage({ id: "settings.taskDefaults.reasoningPickDescription" })}
          control={
            <Select
              value={settings?.defaultReasoningLevelPick ?? "first"}
              onValueChange={(value) =>
                void (async () => {
                  try {
                    await update({
                      defaultReasoningLevelPick: isDefaultReasoningLevelPick(value)
                        ? value
                        : "first",
                    });
                  } catch (error) {
                    toast(error instanceof Error ? error.message : String(error));
                  }
                })()
              }
              disabled={!settings}
            >
              <SelectTrigger size="lg" className={SELECT_TRIGGER_CLASSNAME}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="first">
                  {intl.formatMessage({ id: "settings.taskDefaults.reasoningPick.first" })}
                </SelectItem>
                <SelectItem value="highest">
                  {intl.formatMessage({ id: "settings.taskDefaults.reasoningPick.highest" })}
                </SelectItem>
                {DEFAULT_REASONING_LEVEL_PICK_LEVELS.map((level) => (
                  <SelectItem key={level} value={level}>
                    {reasoningLabel(level)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.taskDefaults.enabled" })}
          description={intl.formatMessage({ id: "settings.taskDefaults.enabledDescription" })}
          control={
            <Switch
              checked={enabled}
              disabled={!settingsReady}
              onCheckedChange={(checked) => void commit({ enabled: checked })}
            />
          }
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.taskDefaults.mode" })}
          description={intl.formatMessage({ id: "settings.taskDefaults.modeDescription" })}
          control={
            <Select
              value={defaults.mode ?? FOLLOW_DEFAULT_VALUE}
              onValueChange={(value) =>
                void commit({
                  mode:
                    value === FOLLOW_DEFAULT_VALUE
                      ? null
                      : (normalizeNewTaskDefaultMode(value as NewTaskDefaults["mode"]) ?? null),
                })
              }
              disabled={!enabled}
            >
              <SelectTrigger size="lg" className={SELECT_TRIGGER_CLASSNAME}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FOLLOW_DEFAULT_VALUE}>{followLabel}</SelectItem>
                {NEW_TASK_DEFAULT_MODE_IDS.map((modeId) => (
                  <SelectItem key={modeId} value={modeId}>
                    {modeLabel(modeId)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.taskDefaults.model" })}
          description={intl.formatMessage({ id: "settings.taskDefaults.modelDescription" })}
          controlLayout="model"
          control={
            <span className="inline-flex min-w-0">
              <ModelConfigSelect
                modelGroups={modelGroups}
                normalizedValue={modelValue}
                triggerLabel={modelTriggerLabel}
                triggerLabelPrefix={modelTriggerParts.prefix}
                triggerLabelValue={modelTriggerParts.value}
                triggerLabelPrefixClassName="text-foreground-subtle"
                showManageModelsAction={false}
                lockReasonMessage=""
                isItemLocked={MODEL_ITEM_NEVER_LOCKED}
                onValueChange={handleModelValueChange}
                leadingItems={modelLeadingItems}
                contentSide="bottom"
                contentAlign="end"
                focusSelectorOnClose={null}
                disabled={!enabled || !catalogReady}
                labelVisibilityClassName="inline-flex min-w-0"
                triggerClassName={MODEL_TRIGGER_CLASSNAME}
                triggerLabelClassName={MODEL_TRIGGER_LABEL_CLASSNAME}
              />
            </span>
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.taskDefaults.reasoningLevel" })}
          description={intl.formatMessage({
            id: catalogReady
              ? "settings.taskDefaults.reasoningLevelDescription"
              : "settings.taskDefaults.catalogUnavailable",
          })}
          control={
            <Select
              value={defaults.reasoningLevel ?? FOLLOW_DEFAULT_VALUE}
              onValueChange={(value) =>
                void commit({ reasoningLevel: value === FOLLOW_DEFAULT_VALUE ? null : value })
              }
              disabled={!enabled || reasoningValues.length === 0}
            >
              <SelectTrigger size="lg" className={SELECT_TRIGGER_CLASSNAME}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FOLLOW_DEFAULT_VALUE}>{followLabel}</SelectItem>
                {reasoningOptions.map((value) => (
                  <SelectItem key={value} value={value}>
                    {reasoningLabel(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        {speedValues.length > 0 ? (
          <SettingsRow
            label={intl.formatMessage({ id: "settings.taskDefaults.speed" })}
            description={intl.formatMessage({ id: "settings.taskDefaults.speedDescription" })}
            control={
              <Select
                value={defaults.speed ?? FOLLOW_DEFAULT_VALUE}
                onValueChange={(value) =>
                  void commit({ speed: value === FOLLOW_DEFAULT_VALUE ? null : value })
                }
                disabled={!enabled}
              >
                <SelectTrigger size="lg" className={SELECT_TRIGGER_CLASSNAME}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={FOLLOW_DEFAULT_VALUE}>{followLabel}</SelectItem>
                  {speedOptions.map((value) => (
                    <SelectItem key={value} value={value}>
                      {speedLabel(value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        ) : null}
      </SettingsGroupCard>
    </div>
  );
}
