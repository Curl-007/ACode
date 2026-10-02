// ============================================================
// Provider Doctor 检查点目录（J3-1 / spec R3 + R7）
// 机制参照 jcode (MIT, github.com/1jehuang/jcode) crates/jcode-provider-doctor，自撰实现。
// ============================================================
//
// 12 个检查点的**单一所有者**：id、展示标签、最低档、是否花费余额、以及失败时给出的
// 下一步命令建议都只在这里定义。渲染层与账本只消费，不再散落 if/else——否则「诊断即产品」
// 的可执行建议会在多个渲染分支里各说一套。

import type { ProviderDoctorCheckpointId, ProviderDoctorTier } from "./types.js";

const TIER_RANK: Readonly<Record<ProviderDoctorTier, number>> = {
  offline: 0,
  catalog: 1,
  live: 2,
};

export const PROVIDER_DOCTOR_TIER_DESCRIPTIONS: Readonly<Record<ProviderDoctorTier, string>> = {
  offline: "无凭据要求、零网络、零花费：验证 ACode 自身接线",
  catalog: "需要凭据、约零花费：追加端点出口校验与实时模型目录",
  live: "需要凭据、花费余额：追加非流式 / 流式 / 工具调用真实调用",
};

export interface ProviderDoctorHintContext {
  readonly providerId: string;
  readonly modelId?: string;
  readonly tier: ProviderDoctorTier;
  readonly accessType?: string;
  readonly accountType?: "zai" | "bigmodel";
  readonly apiType?: string;
  /** 失败详情（已脱敏）；建议文案可据此区分 401 与网络错误。 */
  readonly detail?: string;
  /** 目录内可选的替代模型，用于「换一个模型重跑」的建议。 */
  readonly suggestedModelId?: string;
}

export interface ProviderDoctorCheckpointDefinition {
  readonly id: ProviderDoctorCheckpointId;
  readonly label: string;
  readonly minTier: ProviderDoctorTier;
  readonly spendsBalance: boolean;
  readonly nextStep: (context: ProviderDoctorHintContext) => string;
}

/**
 * 对抗复核 F4：建议命令承诺「可粘贴执行」（spec R7），而 provider / model id 来自用户
 * 配置与实时目录响应——都是不可信输入，裸拼进命令行即构成 shell 注入面（对抗复核实证：
 * 目录 id ``evil`touch pwned` `` 被裸拼、粘贴即命令替换；`my provider; rm -rf /tmp/x`
 * 分号分段）。这里用安全字符集白名单把关：合规 id 逐字拼入；不合规 id 一律退化成
 * 占位符（占位符路线比 POSIX 引号转义更简单、更可审计，spec R7 定案采用占位符）。
 */
const SAFE_COMMAND_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const COMMAND_PROVIDER_ID_PLACEHOLDER = "<provider id（手动输入）>";
const COMMAND_MODEL_ID_PLACEHOLDER = "<模型 id（手动输入）>";

/** id 是否可安全逐字拼进建议命令（spec R7 白名单）。 */
export function isSafeProviderDoctorCommandId(value: string): boolean {
  return SAFE_COMMAND_ID_PATTERN.test(value);
}

/** 拼一条可直接粘贴执行的诊断命令（建议文案的唯一生成点）。 */
export function providerDoctorCommand(context: {
  readonly providerId: string;
  readonly modelId?: string;
  readonly tier: ProviderDoctorTier;
}): string {
  const providerId = context.providerId.trim();
  const providerArg = isSafeProviderDoctorCommandId(providerId)
    ? providerId
    : COMMAND_PROVIDER_ID_PLACEHOLDER;
  const model = context.modelId?.trim();
  const modelArg =
    model === undefined
      ? ""
      : ` --model=${isSafeProviderDoctorCommandId(model) ? model : COMMAND_MODEL_ID_PLACEHOLDER}`;
  return `acode doctor --provider=${providerArg}${modelArg} --tier=${context.tier}`;
}

export function isProviderDoctorTier(value: string): value is ProviderDoctorTier {
  return value === "offline" || value === "catalog" || value === "live";
}

export function providerDoctorTierRank(tier: ProviderDoctorTier): number {
  return TIER_RANK[tier];
}

/** 检查点是否应在该档执行；否则记 skipped（轻档绝不给重档背书）。 */
export function isCheckpointRunAtTier(
  definition: Pick<ProviderDoctorCheckpointDefinition, "minTier">,
  tier: ProviderDoctorTier,
): boolean {
  return TIER_RANK[definition.minTier] <= TIER_RANK[tier];
}

/** 升档建议：tier 通过但未 READY 时必须提示（spec R7）。 */
export function providerDoctorEscalationHint(context: {
  readonly providerId: string;
  readonly modelId?: string;
  readonly tier: ProviderDoctorTier;
}): string | undefined {
  if (context.tier === "live") return undefined;
  const nextTier: ProviderDoctorTier = context.tier === "offline" ? "catalog" : "live";
  const command = providerDoctorCommand({ ...context, tier: nextTier });
  return nextTier === "live"
    ? `${command}（会花费余额：一次非流式 + 一次流式 + 一次工具调用）`
    : `${command}（需要凭据，约零花费）`;
}

const ACCOUNT_LOGIN_HINT = "acode login";

function credentialHint(context: ProviderDoctorHintContext): string {
  if (context.accessType === "zhipu-account") {
    const account = context.accountType === "bigmodel" ? " bigmodel" : "";
    return `账号凭据缺失或不可解密：运行 \`${ACCOUNT_LOGIN_HINT}${account}\` 重新登录，然后重跑 \`${providerDoctorCommand(context)}\``;
  }
  return `未取到可用 API Key：在桌面设置 → Provider 填入 API Key（写入加密凭据库）后重跑 \`${providerDoctorCommand(context)}\`；管理入口见 provider 配置的 apiKeyManagementUrl`;
}

function catalogFailureHint(context: ProviderDoctorHintContext): string {
  const detail = context.detail ?? "";
  if (/\b(401|403|unauthoriz|forbidden|invalid[_ ]?api[_ ]?key)\b/i.test(detail)) {
    return `端点拒绝了凭据（${detail}）：${credentialHint(context)}`;
  }
  return `实时目录端点不可达（${detail || "无详情"}）：检查代理与 CA（HTTPS_PROXY / NO_PROXY / NODE_EXTRA_CA_CERTS）与 Base URL 后重跑 \`${providerDoctorCommand(context)}\``;
}

function modelFailureHint(context: ProviderDoctorHintContext, what: string): string {
  const suggestion = context.suggestedModelId
    ? `换模型重跑 \`${providerDoctorCommand({ ...context, modelId: context.suggestedModelId })}\``
    : `换模型重跑 \`${providerDoctorCommand({ ...context, modelId: "<目录内模型>" })}\``;
  return `${what}：${suggestion}；先用 \`${providerDoctorCommand({ ...context, tier: "catalog" })}\` 确认接线与目录`;
}

/**
 * 检查点定义表。用 `Record<ProviderDoctorCheckpointId, …>` 表达，编译期即穷尽：
 * 新增 id 而忘记给标签/建议会直接类型报错，不会出现「有新检查点但没有下一步」。
 */
const CHECKPOINT_DEFINITIONS: {
  readonly [K in ProviderDoctorCheckpointId]: Omit<ProviderDoctorCheckpointDefinition, "id"> & {
    readonly id: K;
  };
} = {
  config_sources_loaded: {
    id: "config_sources_loaded",
    label: "配置源可加载",
    minTier: "offline",
    spendsBalance: false,
    nextStep: (context) =>
      `Built-in / Personal Provider 配置未就位：确认 ACODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV 与 ACODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV 指向存在的文件（CLI 启动时会自动解析），然后重跑 \`${providerDoctorCommand(context)}\``,
  },
  provider_schema_valid: {
    id: "provider_schema_valid",
    label: "Provider schema 准入",
    minTier: "offline",
    spendsBalance: false,
    nextStep: (context) =>
      `按上面列出的 issue code + 字段路径修复 personal provider 配置（默认 ~/.acode/v2/provider_config.json），然后重跑 \`${providerDoctorCommand(context)}\``,
  },
  endpoint_shape_valid: {
    id: "endpoint_shape_valid",
    label: "端点协议与形态",
    minTier: "offline",
    spendsBalance: false,
    nextStep: (context) =>
      `Base URL 必须是 http/https 的公网端点且 api.type 属 anthropic-messages / openai-chat-completions / openai-responses：在桌面设置 → Provider 修正后重跑 \`${providerDoctorCommand(context)}\``,
  },
  credential_available: {
    id: "credential_available",
    label: "凭据可解密",
    minTier: "offline",
    spendsBalance: false,
    nextStep: credentialHint,
  },
  catalog_models_declared: {
    id: "catalog_models_declared",
    label: "目录已声明模型",
    minTier: "offline",
    spendsBalance: false,
    nextStep: (context) =>
      `Registry 未给该 provider 发布任何模型：升级 CLI 或触发 ACode Built-in 配置刷新后重跑 \`${providerDoctorCommand({ ...context, tier: "catalog" })}\``,
  },
  model_route_resolved: {
    id: "model_route_resolved",
    label: "模型路由可解析",
    minTier: "offline",
    spendsBalance: false,
    nextStep: (context) =>
      `目标模型或推理档位不在目录内：用 --model 指定目录内模型重跑 \`${providerDoctorCommand({ ...context, modelId: context.suggestedModelId ?? "<目录内模型>" })}\``,
  },
  endpoint_public_egress: {
    id: "endpoint_public_egress",
    label: "端点公网出口校验",
    minTier: "catalog",
    spendsBalance: false,
    nextStep: (context) =>
      `端点解析到 localhost / 环回 / 私网 / 保留地址，或不是合法公网主机名：安全策略禁止把 provider 端点指向内网。① 若 Base URL 确实指向内网，改成公网端点；② 若你在代理 / TUN（fake-IP）模式下，本地 DNS 会把公网域名解析成 198.18.x.x 等保留段地址，本检查会如实拒绝——关掉 fake-IP 或换直连网络后重跑；③ offline 档不受影响：\`${providerDoctorCommand({ ...context, tier: "offline" })}\``,
  },
  catalog_live_endpoint: {
    id: "catalog_live_endpoint",
    label: "实时模型目录端点",
    minTier: "catalog",
    spendsBalance: false,
    nextStep: catalogFailureHint,
  },
  catalog_model_listed: {
    id: "catalog_model_listed",
    label: "目标模型在实时目录内",
    minTier: "catalog",
    spendsBalance: false,
    nextStep: (context) =>
      `实时目录里没有该模型：${
        context.suggestedModelId
          ? `改用 \`${providerDoctorCommand({ ...context, modelId: context.suggestedModelId })}\``
          : `用目录返回的模型 id 重跑 --model=<id>`
      }`,
  },
  non_streaming_chat_completion: {
    id: "non_streaming_chat_completion",
    label: "非流式补全",
    minTier: "live",
    spendsBalance: true,
    nextStep: (context) => modelFailureHint(context, "非流式补全失败"),
  },
  streaming_chat_completion: {
    id: "streaming_chat_completion",
    label: "流式补全",
    minTier: "live",
    spendsBalance: true,
    nextStep: (context) => modelFailureHint(context, "流式补全失败"),
  },
  tool_call_parse: {
    id: "tool_call_parse",
    label: "工具调用解析",
    minTier: "live",
    spendsBalance: true,
    nextStep: (context) =>
      `模型没有产出可解析的工具调用：换 supportsToolCall 的模型重跑 \`${providerDoctorCommand({ ...context, modelId: context.suggestedModelId ?? "<支持工具调用的模型>" })}\``,
  },
};

/** 固定顺序：输出、账本、覆盖视图共用同一顺序（spec R3）。 */
const CHECKPOINT_ORDER = [
  "config_sources_loaded",
  "provider_schema_valid",
  "endpoint_shape_valid",
  "credential_available",
  "catalog_models_declared",
  "model_route_resolved",
  "endpoint_public_egress",
  "catalog_live_endpoint",
  "catalog_model_listed",
  "non_streaming_chat_completion",
  "streaming_chat_completion",
  "tool_call_parse",
] as const satisfies readonly ProviderDoctorCheckpointId[];

export const PROVIDER_DOCTOR_CHECKPOINT_CATALOG: readonly ProviderDoctorCheckpointDefinition[] =
  Object.freeze(CHECKPOINT_ORDER.map((id) => Object.freeze(CHECKPOINT_DEFINITIONS[id])));

export const PROVIDER_DOCTOR_CHECKPOINT_IDS: readonly ProviderDoctorCheckpointId[] = Object.freeze(
  CHECKPOINT_ORDER.slice(),
);

export const PROVIDER_DOCTOR_CHECKPOINT_COUNT = CHECKPOINT_ORDER.length;

const DEFINITION_BY_ID = new Map<ProviderDoctorCheckpointId, ProviderDoctorCheckpointDefinition>(
  PROVIDER_DOCTOR_CHECKPOINT_CATALOG.map((definition) => [definition.id, definition]),
);

export function getProviderDoctorCheckpoint(
  id: ProviderDoctorCheckpointId,
): ProviderDoctorCheckpointDefinition {
  const definition = DEFINITION_BY_ID.get(id);
  // 目录由本文件穷尽构造，取不到只可能是 id 联合类型被绕过（例如账本里的旧数据）。
  if (!definition) throw new Error(`Unknown provider doctor checkpoint: ${id}`);
  return definition;
}

export function isProviderDoctorCheckpointId(value: unknown): value is ProviderDoctorCheckpointId {
  return typeof value === "string" && DEFINITION_BY_ID.has(value as ProviderDoctorCheckpointId);
}

/** 账本里出现未知检查点 id（版本演进）时的兜底标签，避免整条证据被丢弃。 */
export function providerDoctorCheckpointLabel(id: string): string {
  return isProviderDoctorCheckpointId(id) ? getProviderDoctorCheckpoint(id).label : id;
}
