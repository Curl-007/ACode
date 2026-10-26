import type {
  ProviderDiagnosticsReasonCode,
  ProviderDiagnosticsRemediationAction,
  ProviderDiagnosticsResult,
} from "@acode/shared";

/**
 * U08 Provider 诊断的 **i18n 文案键映射**（错误码 / 修复动作 / 检查点 → 键）。
 *
 * 从 providerDiagnostics.ts 拆出，避免单文件超 400 行门禁。拆分的内聚边界是：
 * 本文件只做「闭集取值 → i18n 键字符串」的**映射**（exhaustive switch，新增枚举值即 TS 报错），
 * 不含任何判定逻辑——「哪个错误码」由服务端按结构化事实派生，「该显示哪个键」才在这里决定。
 * 三态/fencing/档位授权等**判定**仍在 providerDiagnostics.ts。
 *
 * 所有键都用 `settings.modelProvider.diagnostics.*` 前缀（沿用 settings.modelProvider 命名族）。
 */

// ── R6: 稳定错误码 → i18n 键与修复动作 ────────────────────────────

/**
 * 错误码 → i18n 键。exhaustive switch：契约叶子新增错误码时 TypeScript 在此报错，
 * 防止新码静默落到 default 而显示成「未知错误」。
 *
 * 只做映射，不做判定：判定（哪个码）是服务端按结构化事实派生的，UI 不重新推断。
 */
export function diagnosticsErrorCodeLabelId(
  code: ProviderDiagnosticsReasonCode,
): string {
  const PREFIX = "settings.modelProvider.diagnostics.error";
  switch (code) {
    case "invalid-request":
      return `${PREFIX}.invalidRequest`;
    case "no-agent-runtime":
      return `${PREFIX}.noAgentRuntime`;
    case "live-opt-in-required":
      return `${PREFIX}.liveOptInRequired`;
    case "revision-mismatch":
      return `${PREFIX}.revisionMismatch`;
    case "provider-unknown":
      return `${PREFIX}.providerUnknown`;
    case "cancelled":
      return `${PREFIX}.cancelled`;
    case "execution-failed":
      return `${PREFIX}.executionFailed`;
    case "offline-network-blocked":
      return `${PREFIX}.offlineNetworkBlocked`;
    case "config-source-unavailable":
      return `${PREFIX}.configSourceUnavailable`;
    case "config-schema-invalid":
      return `${PREFIX}.configSchemaInvalid`;
    case "endpoint-shape-invalid":
      return `${PREFIX}.endpointShapeInvalid`;
    case "credential-missing":
      return `${PREFIX}.credentialMissing`;
    case "credential-undecryptable":
      return `${PREFIX}.credentialUndecryptable`;
    case "catalog-not-declared":
      return `${PREFIX}.catalogNotDeclared`;
    case "model-route-unresolved":
      return `${PREFIX}.modelRouteUnresolved`;
    case "endpoint-not-public":
      return `${PREFIX}.endpointNotPublic`;
    case "credential-rejected":
      return `${PREFIX}.credentialRejected`;
    case "catalog-empty":
      return `${PREFIX}.catalogEmpty`;
    case "catalog-unreachable":
      return `${PREFIX}.catalogUnreachable`;
    case "catalog-unsupported":
      return `${PREFIX}.catalogUnsupported`;
    case "model-not-listed":
      return `${PREFIX}.modelNotListed`;
    case "live-probe-failed":
      return `${PREFIX}.liveProbeFailed`;
    case "tool-call-unsupported":
      return `${PREFIX}.toolCallUnsupported`;
  }
}

/**
 * 修复动作 → i18n 键 + 动作类别。
 *
 * `kind` 决定点击后的行为，且是闭集：UI 只能导航到既有页面或重试，
 * **绝不**执行 nextStepCommands（那些命令由 Doctor R7 白名单化，仅供展示/复制）。
 */
export interface RemediationActionView {
  readonly action: ProviderDiagnosticsRemediationAction;
  readonly labelId: string;
  readonly kind: "navigate-settings" | "relogin" | "select-model" | "edit-endpoint" | "check-network" | "escalate-tier" | "retry" | "verify-later";
}

export function remediationActionView(
  action: ProviderDiagnosticsRemediationAction,
): RemediationActionView {
  const PREFIX = "settings.modelProvider.diagnostics.remediation";
  switch (action) {
    case "open-api-key-settings":
      return { action, labelId: `${PREFIX}.openApiKeySettings`, kind: "navigate-settings" };
    case "relogin-account":
      return { action, labelId: `${PREFIX}.reloginAccount`, kind: "relogin" };
    case "select-another-model":
      return { action, labelId: `${PREFIX}.selectAnotherModel`, kind: "select-model" };
    case "edit-endpoint":
      return { action, labelId: `${PREFIX}.editEndpoint`, kind: "edit-endpoint" };
    case "check-network":
      return { action, labelId: `${PREFIX}.checkNetwork`, kind: "check-network" };
    case "escalate-tier-catalog":
      return { action, labelId: `${PREFIX}.escalateCatalog`, kind: "escalate-tier" };
    case "escalate-tier-live":
      return { action, labelId: `${PREFIX}.escalateLive`, kind: "escalate-tier" };
    case "retry-diagnostics":
      return { action, labelId: `${PREFIX}.retry`, kind: "retry" };
    case "verify-later":
      return { action, labelId: `${PREFIX}.verifyLater`, kind: "verify-later" };
  }
}

// ── R5: 检查点呈现（skipped 与 failed 必须可区分）──────────────────

/** 检查点四态 → 视觉变体。只用既有 Badge variant（DESIGN.md：不新造样式）。 */
export function checkpointStatusVariant(
  status: ProviderDiagnosticsResult["checkpoints"][number]["status"],
): "secondary" | "destructive" | "outline" {
  switch (status) {
    case "passed":
      return "secondary";
    case "failed":
      return "destructive";
    // skipped（本档不跑/前置未满足）与 blocked（依赖不可用）都**不是**失败：
    // 用弱化样式，且文案必须区别于 failed（把 skipped 画成失败会误导用户去修没坏的东西）。
    case "skipped":
    case "blocked":
      return "outline";
  }
}

/** 检查点标题 i18n 键。id 是闭集，故可直接映射；未知 id 说明契约漂移，fail-loud。 */
export function checkpointLabelId(id: string): string {
  const PREFIX = "settings.modelProvider.diagnostics.checkpoint";
  switch (id) {
    case "config_sources_loaded":
      return `${PREFIX}.configSourcesLoaded`;
    case "provider_schema_valid":
      return `${PREFIX}.providerSchemaValid`;
    case "endpoint_shape_valid":
      return `${PREFIX}.endpointShapeValid`;
    case "credential_available":
      return `${PREFIX}.credentialAvailable`;
    case "catalog_models_declared":
      return `${PREFIX}.catalogModelsDeclared`;
    case "model_route_resolved":
      return `${PREFIX}.modelRouteResolved`;
    case "endpoint_public_egress":
      return `${PREFIX}.endpointPublicEgress`;
    case "catalog_live_endpoint":
      return `${PREFIX}.catalogLiveEndpoint`;
    case "catalog_model_listed":
      return `${PREFIX}.catalogModelListed`;
    case "non_streaming_chat_completion":
      return `${PREFIX}.nonStreamingChatCompletion`;
    case "streaming_chat_completion":
      return `${PREFIX}.streamingChatCompletion`;
    case "tool_call_parse":
      return `${PREFIX}.toolCallParse`;
    default:
      // 契约漂移（新增 checkpoint 但 UI 没跟上）：不静默显示空白，fail-loud 暴露。
      throw new Error(`unknown diagnostics checkpoint id: ${id}`);
  }
}

/**
 * 检查点状态 i18n 键。四态各自独立文案（R5 / U08-A5）：
 * skipped 必须说清楚「为什么没检查」，而不是笼统的「失败」。
 */
export function checkpointStatusLabelId(
  status: ProviderDiagnosticsResult["checkpoints"][number]["status"],
): string {
  const PREFIX = "settings.modelProvider.diagnostics.status";
  switch (status) {
    case "passed":
      return `${PREFIX}.passed`;
    case "failed":
      return `${PREFIX}.failed`;
    case "skipped":
      return `${PREFIX}.skipped`;
    case "blocked":
      return `${PREFIX}.blocked`;
  }
}

