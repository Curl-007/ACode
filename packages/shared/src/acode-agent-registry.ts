import { z } from "zod";
import type { ACodeProvider } from "./acode-task-types-core.js";
import { acodeEnginePermissionModeSchema } from "./acode-protocol-legacy-types.js";
import { filterBotSelectablePermissionModes } from "./bot-remote-guard.js";

/**
 * Agent 引擎注册表（唯一所有者）。
 *
 * 引擎联合只剩 native(`glm`)——外部引擎槽位（codex/opencode/gemini）已下线
 * （spec: agent-engine-external-slots-removal.md）：其会话协议适配器从未实现、
 * 无 UI 选择入口、bot 命令过滤后不可选。旧持久化 provider 值经
 * resolveAgentEngine / acodeAgentProviderSchema 归一为 native，无需迁移。
 *
 * 命名裁决：ACode 的 "glm" 是自带 bundled native agent（acode.cjs / app-server --stdio），
 * 不是 ZCode 的外部 GLM 引擎；ZCode 的外部 glm 槽位在 ACode 不复刻。
 */
export const ACODE_NATIVE_AGENT_ENGINE = "glm" satisfies ACodeProvider;

/**
 * 引擎 id 列表与 ACodeProvider 联合双向绑定：任一侧漂移即编译失败。
 * native 固定排首位，作为 UI/缺省的稳定锚点。
 */
export const ACODE_AGENT_ENGINE_IDS = ["glm", "jcode"] as const satisfies readonly ACodeProvider[];

export type ACodeAgentEngineId = (typeof ACODE_AGENT_ENGINE_IDS)[number];

export const acodeAgentEngineIdSchema = z.enum(ACODE_AGENT_ENGINE_IDS);

/**
 * 每引擎权限模式集合的取值域，派生自协议 schema（acodeEnginePermissionModeSchema），
 * 避免注册表与协议两侧漂移。
 *
 * native(`glm`) 用 ACode 会话模式（build/edit/plan/yolo）。
 */
export type ACodeAgentPermissionMode = z.infer<typeof acodeEnginePermissionModeSchema>;

export interface ACodeAgentEngineDescriptor {
  id: ACodeAgentEngineId;
  /** UI 展示用的稳定 label（非 i18n key；具体文案见 locales 的 engine.*.name）。 */
  label: string;
  /** native = ACode 自带 bundled agent，走既有 app-server 协议链路。 */
  native: boolean;
  /** 该引擎支持的权限模式（按展示顺序）。 */
  supportedPermissionModes: readonly ACodeAgentPermissionMode[];
  /** 默认权限模式。 */
  defaultPermissionMode: ACodeAgentPermissionMode;
}

const NATIVE_PERMISSION_MODES: readonly ACodeAgentPermissionMode[] = [
  "build",
  "edit",
  "plan",
  "yolo",
  // P1 dontAsk 模式的可达面（specs 权限裁决批2）：ask 漏斗收敛为 deny，不弹窗。
  // 注意 bot-remote-guard 的天花板集**不含** dontAsk 属正确语义（远程无人应答即拒，
  // 不是一种可远程授予的模式），不要为「对齐」把它加进那个集合。
  "dontAsk",
] as const;

/**
 * jcode（外部引擎）的权限模式集：**只有 yolo**。
 *
 * 这是诚实收敛而非偷懒——jcode 后端没有任何权限审批回路（ACP 入站 dispatch 表无
 * permission 方法、harness 桥源码明写 never emits permission_request、实测写文件零审批，
 * 三方印证见 apps/acode-cli/specs/jcode-agent-bridge.md R4-1 与
 * docs/jcode-adapter-spike-2026-10-23.md §3.1/§4.1）。yolo 是现有档位中唯一诚实描述
 * 「无逐动作确认、直通执行」的语义；声明 build/edit/plan 会让 UI 呈现「有权限治理」
 * 而实际没有，属谎报。
 *
 * ⚠ 不要为了让 bot 能选 jcode 而改成 dontAsk 之类不被天花板剔除的档位：
 * bot-remote-guard 的 BOT_REMOTE_FORBIDDEN_PERMISSION_MODES 会剔除 yolo，
 * 于是 getBotSelectablePermissionModes("jcode") 得到**空集**，远程 bot 自动无法驱动
 * jcode——这正是 P0-3 不变量（「远程聊天一条消息 → 主机任意执行」不可接受）要的结果，
 * 由既有机制自动达成，不需要新增守卫代码。
 */
const JCODE_PERMISSION_MODES: readonly ACodeAgentPermissionMode[] = ["yolo"] as const;

/**
 * 引擎注册表。键类型为 ACodeProvider：任何新增 provider 若无注册表条目即编译失败；
 * ACODE_AGENT_ENGINE_IDS 反向 satisfies readonly ACodeProvider[]，两侧穷尽即双向绑定。
 */
export const ACODE_AGENT_ENGINE_REGISTRY: Readonly<
  Record<ACodeProvider, ACodeAgentEngineDescriptor>
> = {
  glm: {
    id: "glm",
    label: "ACode Agent",
    native: true,
    supportedPermissionModes: NATIVE_PERMISSION_MODES,
    defaultPermissionMode: "build",
  },
  // 外部引擎（spec: packages/shared/specs/agent-engine-jcode-slot.md）。
  // 与曾被删除的 codex/opencode/gemini 空槽位不同：适配器已实现（apps/acode-cli 的
  // jcode-bridge 子命令，北向 v4 / 南向 ACP），且经真实客户端栈验证——L1
  // ACodeAgentProcessManager、L2 createACodeAgentService 均用真 jcode + 真模型跑通
  // 一轮带工具调用的会话（apps/acode-cli/specs/jcode-agent-bridge.md 附录 A.5）。
  jcode: {
    id: "jcode",
    label: "jcode",
    native: false,
    supportedPermissionModes: JCODE_PERMISSION_MODES,
    defaultPermissionMode: "yolo",
  },
};

export function isAgentEngineId(value: unknown): value is ACodeAgentEngineId {
  return typeof value === "string" && (ACODE_AGENT_ENGINE_IDS as readonly string[]).includes(value);
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
