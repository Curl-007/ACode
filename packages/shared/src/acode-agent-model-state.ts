// ── 旧协议兼容面（过渡期）──────────────────────────────
// 剩余 5 个导出：旧 configOptions 投影函数（formatModelPickerValue/normalizeAvailableACodeMode/
// getACodeAgentModeSelectOptions/getACodeAgentAvailableModes/
// acodeSessionSettingsToACodeConfigOptions）。
// 消费者：services acodeConfigOptions、UI acodeSessionProjection 等旧栈。
import { formatModelPickerValue } from "./model-selection.js";
import { getAgentEnginePermissionModes } from "./acode-agent-registry.js";
import type { ACodeSessionMode, ACodeSessionSettingsState } from "./acode-protocol/index.js";
import type {
  ACodeConfigOption,
  ACodeTaskModeInfo,
  ACodeProvider,
} from "./acode-task-types-core.js";
const MODEL_CONFIG_ID = "model";
const MODEL_CONFIG_CATEGORY = "model";
const MODE_CONFIG_ID = "mode";
const MODE_CONFIG_CATEGORY = "mode";
const THOUGHT_LEVEL_CONFIG_ID = "thought_level";
const THOUGHT_LEVEL_CONFIG_CATEGORY = "thought_level";
const ACODE_AGENT_MODE_OPTIONS = [
  {
    id: "build",
    name: "Ask before changes",
    description: "Ask before each file changes.",
  },
  {
    id: "edit",
    name: "Edit automatically",
    description: "Edit selected files or relevant workspace files automatically.",
  },
  {
    id: "plan",
    name: "Plan mode",
    description: "Inspect the code and present a plan before editing.",
  },
  {
    id: "yolo",
    name: "Full access",
    description: "Edit and run commands with fewer confirmations.",
  },
  {
    // P1 dontAsk：需要确认的动作一律拒绝并说明原因，绝不弹窗等待（文案自撰）。
    id: "dontAsk",
    name: "Deny instead of asking",
    description: "Never prompt; anything that would need confirmation is denied with a reason.",
  },
] as const satisfies readonly ACodeTaskModeInfo[];
const ACODE_AGENT_MODE_ID_SET = new Set<string>(ACODE_AGENT_MODE_OPTIONS.map((mode) => mode.id));

// OpenRouter 会把 `:free` 作为模型 ID 的一部分。UI/configOptions 的展示态
// 不能再用冒号分隔 thought level，否则草稿选择会静默截断真实 modelId。
export function normalizeAvailableACodeMode(mode: ACodeSessionMode): string {
  return ACODE_AGENT_MODE_ID_SET.has(mode) ? mode : "build";
}

export function getACodeAgentModeSelectOptions(): NonNullable<ACodeConfigOption["options"]> {
  return ACODE_AGENT_MODE_OPTIONS.map((mode) => ({
    value: mode.id,
    name: mode.name,
    description: mode.description,
  }));
}

/**
 * 某引擎的可用模式（引擎作用域）。
 *
 * 按引擎的 supportedPermissionModes 过滤 ACODE_AGENT_MODE_OPTIONS（mode option 的 id 与
 * 权限模式名一一对应）：glm 得全部 5 档（build/edit/plan/yolo/dontAsk），jcode 只得 yolo
 * （其后端无权限审批回路，见 acode-agent-registry 的 JCODE_PERMISSION_MODES 注释与
 * agent-engine-jcode-slot.md R2）。非法/旧值经 getAgentEnginePermissionModes→resolveAgentEngine
 * 归一后回退 native。
 *
 * 曾是 `void engineId; return 全部` —— 那会让 jcode 也呈现 build/edit/plan 这些它不支持的档，
 * 用户选了却无对应权限治理（谎报）。改为引擎作用域过滤（spec: agent-engine-jcode-slot.md R7）。
 */
export function getACodeAgentAvailableModes(
  engineId?: ACodeProvider | string | null,
): ACodeTaskModeInfo[] {
  const supported = getAgentEnginePermissionModes(engineId) as readonly string[];
  return ACODE_AGENT_MODE_OPTIONS.filter((mode) => supported.includes(mode.id)).map((mode) => ({
    ...mode,
  }));
}

export function acodeSessionSettingsToACodeConfigOptions(
  settings: ACodeSessionSettingsState,
): ACodeConfigOption[] {
  const configOptions: ACodeConfigOption[] = [
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      category: MODEL_CONFIG_CATEGORY,
      type: "select",
      currentValue: formatModelPickerValue(settings.model.current),
      options: settings.model.available.map((model) => {
        const modelThoughtLevels = model.reasoning?.levels.map((level) => level.value);
        const modelDefaultThoughtLevel =
          model.reasoning?.defaultLevel &&
          modelThoughtLevels?.includes(model.reasoning.defaultLevel)
            ? model.reasoning.defaultLevel
            : undefined;
        return {
          value: formatModelPickerValue(model.ref),
          name: model.label,
          description: model.description,
          modelProviderId: model.ref.providerId,
          modelProviderName: model.providerLabel ?? model.ref.providerId,
          ...(modelThoughtLevels ? { modelThoughtLevels } : {}),
          ...(modelDefaultThoughtLevel ? { modelDefaultThoughtLevel } : {}),
        };
      }),
    },
    {
      id: MODE_CONFIG_ID,
      name: "Mode",
      category: MODE_CONFIG_CATEGORY,
      type: "select",
      currentValue: normalizeAvailableACodeMode(settings.mode.current),
      options: getACodeAgentModeSelectOptions(),
    },
  ];
  if (settings.thoughtLevel.enabled) {
    const thoughtLevelValues = new Set(settings.thoughtLevel.available.map((level) => level.value));
    const defaultThoughtLevel =
      settings.thoughtLevel.defaultLevel &&
      thoughtLevelValues.has(settings.thoughtLevel.defaultLevel)
        ? settings.thoughtLevel.defaultLevel
        : undefined;
    configOptions.push({
      id: THOUGHT_LEVEL_CONFIG_ID,
      name: "Thought Level",
      category: THOUGHT_LEVEL_CONFIG_CATEGORY,
      type: "select",
      currentValue:
        settings.thoughtLevel.current ??
        defaultThoughtLevel ??
        settings.thoughtLevel.available[0]?.value ??
        "",
      options: settings.thoughtLevel.available.map((level) => ({
        value: level.value,
        name: level.label,
        description: level.description,
      })),
    });
  }
  return configOptions;
}
