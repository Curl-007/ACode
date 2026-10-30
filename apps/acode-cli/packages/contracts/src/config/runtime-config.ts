// RuntimeConfig 配置簇 —— 运行时配置快照形态与默认值工厂。
// 例外偿还（contracts-onboarding-max-file-lines-config-index）：自 config/index.ts
// 拆出。原 index.ts 降为 barrel 并对本叶 `export *`，公开导出面逐名不变。
// 依赖单向：config-keys → 本叶 → managed-policy（叶子间无环）。
// SkillCommandOverride 随 RuntimeConfig 的 skillOverrides/commandOverrides 落在本叶，
// 避免 config-keys ↔ runtime-config 叶子互指。

import type { CollaborationMode } from "../interfaces/session.port.js";
import type { McpServerConfig } from "../interfaces/mcp.port.js";
import type { HooksRuntimeConfig, HooksRuntimeConfigPatch } from "../hooks/index.js";
import type { PluginConfig } from "../plugins/index.js";
import type { ManagedPolicyFloorData } from "./managed-policy.js";

// ============================================================
// Skill / Command 可用性覆盖值形态（config `skill`/`command` 键）
// ============================================================

// 按绝对路径覆盖单个 skill / 命令是否可用。未列出的条目默认可用，
// 只有显式 enable:false 才会在发现阶段被过滤掉。
export interface SkillCommandOverride {
  enable?: boolean;
}

// ============================================================
// Runtime Config
// ============================================================

export interface RuntimeConfig {
  modelStream: ModelStreamConfig;
  permission: {
    mode: CollaborationMode;
    allowedTools: string[];
    disallowedTools: string[];
    autoApproveHighRisk: boolean;
    allowMediumRiskInAuto: boolean;
    /** 安全加固 P2：托管策略地板；缺省表示本机未部署策略文件（零行为变化）。 */
    policy?: ManagedPolicyFloorData;
  };
  storage: {
    dir: string;
    sessionDbPath: string;
  };
  network: {
    httpProxy?: string;
    noProxy?: string;
    caCertFile?: string;
    timeout: number;
  };
  features: {
    compact: boolean;
    rewind: boolean;
    subagent: boolean;
    memory: boolean;
    skill: boolean;
    mcp: boolean;
  };
  memory: {
    use: boolean;
  };
  mcp: {
    servers: Record<string, McpServerConfig>;
  };
  plugins: PluginConfig;
  skills: {
    enabled: boolean;
    includeInstructions: boolean;
    metadataBudget: number;
    roots: string[];
    [skillPath: string]: boolean | number | string[] | { enable?: boolean };
  };
  // key 为 SKILL.md 绝对路径，value.enable=false 表示禁用该 skill
  skillOverrides: Record<string, SkillCommandOverride>;
  // key 为命令 .md 绝对路径，value.enable=false 表示禁用该命令
  commandOverrides: Record<string, SkillCommandOverride>;
  logging: {
    level: "debug" | "info" | "warn" | "error";
    format: "text" | "json";
  };
  toolConcurrency: ToolConcurrencyConfig;
  modelAnomalyGuard: ModelAnomalyGuardConfig;
  /** 跨回合 auto-resume（specs/turn-auto-resume.md）；默认值见 DefaultRuntimeConfig.autoResume。 */
  autoResume: AutoResumeConfig;
  hooks: HooksRuntimeConfig;
  ui: {
    locale: UiLocale;
    theme: UiThemePreference;
  };
}

export interface RuntimeConfigPatch {
  modelStream?: Partial<ModelStreamConfig>;
  permission?: Partial<RuntimeConfig["permission"]>;
  storage?: Partial<RuntimeConfig["storage"]>;
  network?: Partial<RuntimeConfig["network"]>;
  features?: Partial<RuntimeConfig["features"]>;
  memory?: Partial<RuntimeConfig["memory"]>;
  mcp?: Partial<RuntimeConfig["mcp"]>;
  plugins?: Partial<RuntimeConfig["plugins"]>;
  skills?: Partial<RuntimeConfig["skills"]>;
  skillOverrides?: RuntimeConfig["skillOverrides"];
  commandOverrides?: RuntimeConfig["commandOverrides"];
  logging?: Partial<RuntimeConfig["logging"]>;
  toolConcurrency?: Partial<RuntimeConfig["toolConcurrency"]>;
  modelAnomalyGuard?: Partial<RuntimeConfig["modelAnomalyGuard"]>;
  autoResume?: Partial<RuntimeConfig["autoResume"]>;
  hooks?: HooksRuntimeConfigPatch;
  ui?: Partial<RuntimeConfig["ui"]>;
}

export type SupportedLocale = "en-US" | "zh-CN";
export type UiLocale = SupportedLocale | "auto";
export type UiThemeMode = "dark" | "light";
export type UiThemePreference = UiThemeMode | "auto";

export const DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS = 600_000;

export interface ModelStreamConfig {
  idleTimeoutMs: number;
}

export const DefaultRuntimeConfig: RuntimeConfig = {
  modelStream: {
    idleTimeoutMs: DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS,
  },
  permission: {
    mode: "build",
    allowedTools: [],
    disallowedTools: [],
    autoApproveHighRisk: false,
    allowMediumRiskInAuto: false,
  },
  storage: {
    dir: "~/.acode",
    sessionDbPath: "~/.acode/cli/db/db.sqlite",
  },
  network: {
    timeout: 180000,
  },
  features: {
    compact: true,
    rewind: true,
    subagent: true,
    memory: true,
    skill: true,
    mcp: true,
  },
  memory: {
    use: true,
  },
  mcp: {
    servers: {},
  },
  plugins: {
    dirs: [],
    enabled: true,
    enabledPlugins: {},
    extraKnownMarketplaces: {},
    options: {},
    suppressedBuiltins: [],
  },
  skills: {
    enabled: true,
    includeInstructions: true,
    metadataBudget: 20_000,
    roots: [],
  },
  skillOverrides: {},
  commandOverrides: {},
  logging: {
    level: "info",
    format: "text",
  },
  toolConcurrency: {
    maxConcurrency: 10,
  },
  modelAnomalyGuard: {
    maxBudgetWarningsPerTurn: 3,
    repeatedToolCallWarningThreshold: 3,
  },
  // 默认值分档裁决（specs/turn-auto-resume.md「配置面」）：attended/unattended 统一
  // enabled=true——adapter 已重试 10 次后仍失败的跨回合故障是稀有事件，两类场景都受益；
  // 惊讶成本由 maxResumes/退避上限/命令 off 覆盖。
  autoResume: {
    enabled: true,
    maxResumes: 8,
    cooldownBaseSec: 10,
    cooldownFactor: 2,
    cooldownMaxSec: 60,
    loopGuardRepeats: 3,
  },
  hooks: {
    enabled: false,
    events: {},
    maxOutputBytes: 32768,
    timeoutMs: 60000,
  },
  ui: {
    locale: "en-US",
    theme: "auto",
  },
};

// ============================================================
// Tool Concurrency Config
// ============================================================

export interface ToolConcurrencyConfig {
  maxConcurrency: number;
}

export interface ModelAnomalyGuardConfig {
  toolCallWarningThreshold?: number;
  repeatedToolCallWarningThreshold: number;
  maxBudgetWarningsPerTurn: number;
}

/**
 * 跨回合 auto-resume 配置（specs/turn-auto-resume.md「配置面」，modelAnomalyGuard 全链路
 * 同构）。运行态计数/定时器/暂停 overlay 不在这里——它们只住 core coordinator 的进程内
 * per-session 内存，不跨进程持久化。
 */
export interface AutoResumeConfig {
  /** 长期开关；/auto-resume on|off（裸）持久化写这里。 */
  enabled: boolean;
  /** 同会话连续自动继续上限；任一重置条件命中后清零。 */
  maxResumes: number;
  /** 退避基数（秒）：第 n 次等待 = min(base × factor^(n−1), max)。 */
  cooldownBaseSec: number;
  /** 退避倍率。 */
  cooldownFactor: number;
  /** 退避上限（秒）。 */
  cooldownMaxSec: number;
  /** 循环守卫：相同错误签名（reason+statusCode+providerCode）连续出现超过该次数即停止。 */
  loopGuardRepeats: number;
  /** 自定义继续指令（仅作用 transient 档）；支持 {count}/{max}/{remaining} 占位符。 */
  continueMessage?: string;
}
