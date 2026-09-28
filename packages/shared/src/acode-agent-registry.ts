import { z } from "zod";
import type { ACodeProvider } from "./acode-task-types-core.js";
import { acodeEnginePermissionModeSchema } from "./acode-protocol-legacy-types.js";
import { filterBotSelectablePermissionModes } from "./bot-remote-guard.js";

/**
 * Agent 引擎注册表（唯一所有者）。
 *
 * 引擎联合 = ACode native(`glm`) + 外部引擎(codex/opencode/gemini)。native 永远是缺省，
 * 所有已持久化的 provider:"glm" 与 bot 配置保持有效，无需迁移。
 *
 * 命名裁决：ACode 的 "glm" 是自带 bundled native agent（acode.cjs / app-server --stdio），
 * 不是 ZCode 的外部 GLM 引擎；ZCode 的外部 glm 槽位在 ACode 不复刻。
 */
export const ACODE_NATIVE_AGENT_ENGINE = "glm" satisfies ACodeProvider;

/**
 * 引擎 id 列表与 ACodeProvider 联合双向绑定：任一侧漂移即编译失败。
 * native 固定排首位，作为 UI/缺省的稳定锚点。
 */
export const ACODE_AGENT_ENGINE_IDS = [
  "glm",
  "codex",
  "opencode",
  "gemini",
] as const satisfies readonly ACodeProvider[];

export type ACodeAgentEngineId = (typeof ACODE_AGENT_ENGINE_IDS)[number];

export const acodeAgentEngineIdSchema = z.enum(ACODE_AGENT_ENGINE_IDS);

/**
 * 每引擎权限模式集合的取值域，派生自协议 schema（acodeEnginePermissionModeSchema），
 * 避免注册表与协议两侧漂移。
 *
 * native(`glm`) 用 ACode 会话模式（build/edit/plan/yolo）；外部引擎取自 ZCode 权限模式联合。
 * codex 语义上走 approvalPolicy/sandboxMode（既有 bots schema 已承载），不复用 build/edit/plan/yolo。
 */
export type ACodeAgentPermissionMode = z.infer<typeof acodeEnginePermissionModeSchema>;

export interface ACodeAgentEngineDescriptor {
  id: ACodeAgentEngineId;
  /** UI 展示用的稳定 label（非 i18n key；具体文案见 locales 的 engine.*.name）。 */
  label: string;
  /** native = ACode 自带 bundled agent，走既有 app-server 协议链路。 */
  native: boolean;
  /**
   * 是否已实现「真正驱动会话」。外部引擎的会话协议适配器属净新增、ZCode 无参考，
   * 当前范围内为 false：binary 发现 / 诊断 / spawn 命令解析可用，但不接入会话协议桥。
   */
  implemented: boolean;
  /** 该引擎支持的权限模式（按展示顺序）。 */
  supportedPermissionModes: readonly ACodeAgentPermissionMode[];
  /** 默认权限模式。 */
  defaultPermissionMode: ACodeAgentPermissionMode;
  /** 外部引擎是否用 approvalPolicy/sandboxMode 而非 permissionMode 表达授权（codex=true）。 */
  usesApprovalPolicy?: boolean;
}

const NATIVE_PERMISSION_MODES: readonly ACodeAgentPermissionMode[] = [
  "build",
  "edit",
  "plan",
  "yolo",
] as const;

/**
 * 引擎注册表。键类型为 ACodeProvider：任何新增 provider 若无注册表条目即编译失败；
 * ACODE_AGENT_ENGINE_IDS 反向 satisfies readonly ACodeProvider[]，两侧穷尽即双向绑定。
 */
export const ACODE_AGENT_ENGINE_REGISTRY: Readonly<Record<ACodeProvider, ACodeAgentEngineDescriptor>> =
  {
    glm: {
      id: "glm",
      label: "ACode Agent",
      native: true,
      implemented: true,
      supportedPermissionModes: NATIVE_PERMISSION_MODES,
      defaultPermissionMode: "build",
    },
    codex: {
      id: "codex",
      label: "Codex",
      native: false,
      implemented: false,
      // codex 走 approvalPolicy/sandboxMode；这里给出 ZCode 联合中与之对应的授权档位。
      supportedPermissionModes: ["default", "acceptEdits", "bypassPermissions"] as const,
      defaultPermissionMode: "default",
      usesApprovalPolicy: true,
    },
    opencode: {
      id: "opencode",
      label: "OpenCode",
      native: false,
      implemented: false,
      supportedPermissionModes: ["default", "plan", "acceptEdits", "bypassPermissions"] as const,
      defaultPermissionMode: "default",
    },
    gemini: {
      id: "gemini",
      label: "Gemini",
      native: false,
      implemented: false,
      supportedPermissionModes: ["default", "yolo"] as const,
      defaultPermissionMode: "default",
    },
  };

export function isAgentEngineId(value: unknown): value is ACodeAgentEngineId {
  return (
    typeof value === "string" &&
    (ACODE_AGENT_ENGINE_IDS as readonly string[]).includes(value)
  );
}

export function isNativeAgentEngine(engineId: ACodeAgentEngineId): boolean {
  return ACODE_AGENT_ENGINE_REGISTRY[engineId].native;
}

/** 解析任意输入为引擎描述符；非引擎值回退 native（旧数据/未知 provider 兼容）。 */
export function resolveAgentEngine(
  engineId?: ACodeProvider | string | null,
): ACodeAgentEngineDescriptor {
  if (isAgentEngineId(engineId)) {
    return ACODE_AGENT_ENGINE_REGISTRY[engineId];
  }
  return ACODE_AGENT_ENGINE_REGISTRY[ACODE_NATIVE_AGENT_ENGINE];
}

/** 全量引擎描述符，按 ACODE_AGENT_ENGINE_IDS 顺序（native 首位）。 */
export function getAgentEngineDescriptors(): ACodeAgentEngineDescriptor[] {
  return ACODE_AGENT_ENGINE_IDS.map((id) => ({ ...ACODE_AGENT_ENGINE_REGISTRY[id] }));
}

/** 某引擎支持的权限模式列表。 */
export function getAgentEnginePermissionModes(
  engineId?: ACodeProvider | string | null,
): readonly ACodeAgentPermissionMode[] {
  return resolveAgentEngine(engineId).supportedPermissionModes;
}

/**
 * 远程 bot 入口可选的权限模式（安全加固 P0-3 天花板）。
 *
 * = 引擎支持集剔除全权限档（yolo/bypassPermissions）。bot 驱动的会话永不可达全权限：
 * 远程聊天一条消息即能放大成 host 上的任意副作用执行，需要这些模式必须在桌面本地显式操作。
 * services 的 `/mode` 列表与派发咽喉、UI 的 bot 默认权限模式卡片都从本函数派生，单一事实源、不内联枚举。
 */
export function getBotSelectablePermissionModes(
  engineId?: ACodeProvider | string | null,
): readonly ACodeAgentPermissionMode[] {
  return filterBotSelectablePermissionModes(getAgentEnginePermissionModes(engineId));
}
