// ============================================================
// Dynamic Workflow 灰度：服务端 feature key 的取值域与客户端快照
// ============================================================
// 服务端 `/api/v1/client/configs` 下发 `data.configs.dynamicWorkflow.mode`。

// 这里只放三端（Host services、Desktop main、UI）共用的取值域、归一化与快照形状；
// 读取远端、覆盖与下发都在各自的 owner 里，不在 shared 层发请求。

export const DYNAMIC_WORKFLOW_MODES = ["disabled", "onDemand", "alwaysOn"] as const;
export type DynamicWorkflowMode = (typeof DYNAMIC_WORKFLOW_MODES)[number];

/**
 * 本地覆盖用的环境变量。语义按构建档位分三层，由 Desktop main 在 fork Host 前**改写或删除**
 * （desktopRuntimeEnv.ts 的 buildHostProcessEnv），Host 只消费不再分辨来源：
 *   - 未打包 dev：透传开发者 shell 里的合法取值；
 *   - 打包 preview：固定写入 `alwaysOn`，忽略 shell；
 *   - 打包 production：删除继承值，永不写入——于是 production 走「远端说了算，远端没说才落
 *     缺省」，服务端因此保有关闭它的手段（若这里改成写入 `alwaysOn`，override 会压过远端，
 *     否决权就没了）。
 * 没有 main 的 Web/server Host 直接读进程环境（运维/开发者设置）。
 */
export const ACODE_DYNAMIC_WORKFLOW_MODE_ENV = "ACODE_DYNAMIC_WORKFLOW_MODE";

/**
 * 服务端缺省、格式非法或请求失败时的取值：fail-open。
 *
 * 为什么与闲时任务灰度分叉（那里仍 fail-closed）：dwf 的十个工具全部在本机执行，灰度是
 * **发布节奏控制**而不是安全或计费边界；Off-Peak 会把任务投递到远端空闲算力队列，它的
 * fail-closed 挡的是资源与计费。两者共用一个缺省值只是历史巧合，不是同一条裁决。
 * 见 specs/dynamic-workflow-availability.md R2。
 *
 * 反转的是**缺省档位**，不是优先级：环境变量仍是 override 并压过远端，远端显式下发
 * `disabled` 在无本地覆盖的档位上仍然关闭（R4 远端否决权）。也正因为 override 压过远端，
 * 这里**不能**改成让 Desktop 在 production 档写入 `alwaysOn`——那会让本地环境盖掉服务端的
 * `disabled`，远端就此失去回收灰度的手段。
 */
export const DEFAULT_DYNAMIC_WORKFLOW_MODE: DynamicWorkflowMode = "alwaysOn";

export function normalizeDynamicWorkflowMode(value: unknown): DynamicWorkflowMode | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return (DYNAMIC_WORKFLOW_MODES as readonly string[]).includes(trimmed)
    ? (trimmed as DynamicWorkflowMode)
    : undefined;
}

/**
 * 解析保留服务端契约的三态，消费侧统一转换为布尔开关。
 * 将来 onDemand 有独立行为时，只需调整消费侧。
 */
export function isDynamicWorkflowModeEnabled(mode: DynamicWorkflowMode): boolean {
  return mode !== "disabled";
}

/** 快照的来源：观测用，UI 与日志据此区分「服务端关」与「本地覆盖」。 */
export type DynamicWorkflowClientConfigSource = "remote" | "override" | "default";

export interface DynamicWorkflowClientConfig {
  readonly mode: DynamicWorkflowMode;
  /** 等于 isDynamicWorkflowModeEnabled(mode)；单独落字段免得每个消费者各写一遍折叠规则。 */
  readonly enabled: boolean;
  readonly source: DynamicWorkflowClientConfigSource;
}

export function createDynamicWorkflowClientConfig(
  mode: DynamicWorkflowMode,
  source: DynamicWorkflowClientConfigSource,
): DynamicWorkflowClientConfig {
  return { mode, enabled: isDynamicWorkflowModeEnabled(mode), source };
}

/**
 * 纯函数：把远端 envelope 的 `configs.dynamicWorkflow` 与本地覆盖环境变量折叠成一个快照。
 * 优先级：覆盖 > 远端合法值 > 缺省。远端成功但**未下发**该 key 视为「远端没说」，落缺省
 * （`DEFAULT_DYNAMIC_WORKFLOW_MODE`）——即服务端撤掉 key 不再等于关闭，而是交还给缺省档位；
 * 要关必须显式下发 `mode: "disabled"`。仍不沿用旧快照：每次判定都从这三段重新折叠。
 */
export function resolveDynamicWorkflowClientConfig(input: {
  remote: unknown;
  env?: Record<string, string | undefined>;
}): DynamicWorkflowClientConfig {
  const override = normalizeDynamicWorkflowMode(input.env?.[ACODE_DYNAMIC_WORKFLOW_MODE_ENV]);
  if (override) return createDynamicWorkflowClientConfig(override, "override");
  const remoteMode = normalizeDynamicWorkflowMode(
    typeof input.remote === "object" && input.remote !== null
      ? (input.remote as { mode?: unknown }).mode
      : undefined,
  );
  if (remoteMode) return createDynamicWorkflowClientConfig(remoteMode, "remote");
  return createDynamicWorkflowClientConfig(DEFAULT_DYNAMIC_WORKFLOW_MODE, "default");
}
