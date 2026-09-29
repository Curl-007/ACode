import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasBlockingConfigIssues,
  isBlockingConfigIssue,
  type ConfigValidationIssue,
} from "../src/config-overlay.js";
import { isPlaintextHttpBaseUrl } from "../src/config/provider-endpoint-security.js";
import {
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
} from "../src/config/provider-config.js";
import { ModelConfig, ModelConfigRules } from "../src/config/model-config.js";
import {
  createRegistryProviderConfig,
  ProviderConfigResolver,
  type ProviderConfigResolverInput,
} from "../src/resolver.js";

/**
 * spec: packages/provider/specs/config-validation-severity.md 的验收测试。
 *
 * 守护的核心性质：
 * - severity 是 additive 契约：缺省视为 error，全部既有阻断语义逐字保持；
 * - 明文 http baseUrl 只产出一条 warning（唯一产生点 ProviderApiConfig.validateComplete），
 *   不阻断可执行/可选/registry 准入，但必须流入 resolution.issues 诊断面；
 * - 非法 URL 的报错仍归 zod（invalid-url），判定函数对非法值返回 false，不双报。
 */

const PROVIDER_ID = "custom-http-test";
const MODEL_ID = "test-model";

/** 完整可执行的模型数据：形状与内置 config 的模型一致，缺一项 registry 模型校验就不通过。 */
const completeModelData = {
  enabled: true,
  properties: {
    requiresMfjsToolSchema: false,
    contextWindow: 200000,
    inputFormat: {
      supportsText: true,
      supportsImage: false,
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    },
    outputFormat: { supportsText: true },
    supportsToolCall: true,
    supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: false,
  },
  optionSpecs: {
    reasoningLevel: { values: ["disabled", "enabled"], map: "{}" },
    maxOutputTokens: { max: 32000, map: "{}" },
  },
};

/**
 * 构造一份完整的个人 Provider 规则：complete schema 要求 group/access/api 齐全，
 * 且 provider 没有可用模型时会被 registry 排除，因此成员与模型规则必须一并给出。
 */
function providerRule({
  baseUrl,
  withAccess = true,
}: {
  baseUrl: string;
  withAccess?: boolean;
}) {
  return {
    providerId: PROVIDER_ID,
    providerName: "HTTP Warning Test",
    enabled: true,
    config: new ProviderConfig({
      group: "standard-personal",
      ...(withAccess
        ? { access: new ApiKeyAccessConfig({ type: "api-key", apiKey: "sk-test" }) }
        : {}),
      api: new ProviderApiConfig({
        type: "openai-chat-completions",
        baseUrl,
      }),
      personalModelIds: [MODEL_ID],
      modelOrder: [MODEL_ID],
    }),
  };
}

/** 组装 resolver 输入：模型配置只经个人精确规则注入，避免空规则解析出不可执行模型。 */
function resolverInput(rule: ReturnType<typeof providerRule>): ProviderConfigResolverInput {
  return {
    acodeBuiltinProviders: new ProviderConfigMap(),
    personalProviders: new ProviderConfigMap([rule]),
    acodeBuiltinModelRules: ModelConfigRules.empty(),
    personalModels: new ModelConfigRules([
      {
        type: "provider-model",
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
        config: ModelConfig.fromData(completeModelData),
      },
    ]),
    accountProviders: new ProviderConfigMap(),
  };
}

function plaintextWarning(): ConfigValidationIssue {
  return {
    code: "plaintext-http-endpoint",
    path: ["providers", PROVIDER_ID, "api", "baseUrl"],
    message: "明文 http",
    severity: "warning",
  };
}

function blockingIssue(): ConfigValidationIssue {
  return {
    code: "invalid-config",
    path: ["providers", PROVIDER_ID],
    message: "配置错误",
  };
}

test("helper truth table: missing severity blocks, warning does not", () => {
  // 契约核心：缺省 severity 视为 error，保证全部既有产生点零改动即保持阻断语义。
  assert.equal(isBlockingConfigIssue(blockingIssue()), true);
  assert.equal(isBlockingConfigIssue({ ...blockingIssue(), severity: "error" }), true);
  assert.equal(isBlockingConfigIssue(plaintextWarning()), false);

  assert.equal(hasBlockingConfigIssues([]), false);
  assert.equal(hasBlockingConfigIssues([plaintextWarning()]), false);
  assert.equal(hasBlockingConfigIssues([plaintextWarning(), blockingIssue()]), true);
  assert.equal(hasBlockingConfigIssues([blockingIssue(), plaintextWarning()]), true);
});

test("production point: http baseUrl yields exactly one plaintext-http-endpoint warning", () => {
  const issues = [
    ...new ProviderApiConfig({
      type: "openai-chat-completions",
      baseUrl: "http://api.example.com/v1",
    }).validateComplete(["providers", PROVIDER_ID, "api"]),
  ];
  assert.equal(issues.length, 1);
  const warning = issues[0]!;
  assert.equal(warning.code, "plaintext-http-endpoint");
  assert.equal(warning.severity, "warning");
  assert.deepEqual([...warning.path], ["providers", PROVIDER_ID, "api", "baseUrl"]);
  assert.ok(warning.message.includes("https"), "message must suggest https");
});

test("production point: https baseUrl stays silent (regression guard)", () => {
  const issues = new ProviderApiConfig({
    type: "openai-chat-completions",
    baseUrl: "https://api.example.com/v1",
  }).validateComplete(["providers", PROVIDER_ID, "api"]);
  assert.equal(issues.length, 0);
});

test("production point: invalid URL reports only the zod error, no duplicated warning", () => {
  // 非法 URL 归 zod 的 invalid-url；isPlaintextHttpBaseUrl 对非法值返回 false，不双报。
  assert.equal(isPlaintextHttpBaseUrl("not-a-url"), false);
  const issues = [
    ...new ProviderApiConfig({
      type: "openai-chat-completions",
      baseUrl: "not-a-url",
    }).validateComplete(["providers", PROVIDER_ID, "api"]),
  ];
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.code, "invalid-url");

  // 空 baseUrl 是缺必填（error），同样不应产出 warning。
  const emptyIssues = [
    ...new ProviderApiConfig({
      type: "openai-chat-completions",
      baseUrl: "",
    }).validateComplete(["providers", PROVIDER_ID, "api"]),
  ];
  assert.equal(emptyIssues.length, 1);
  assert.equal(emptyIssues[0]!.code, "required-field-missing");
});

test("ProviderConfig.validateComplete surfaces the api warning for the resolver path", () => {
  // resolver 只对 effective ProviderConfig 调 validateComplete，warning 必须经由此处流转。
  const issues = [
    ...providerRule({ baseUrl: "http://api.example.com/v1" }).config.validateComplete([
      "providers",
      PROVIDER_ID,
    ]),
  ];
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.code, "plaintext-http-endpoint");
  assert.equal(issues[0]!.severity, "warning");
  // 同一份 https 配置在 provider 级仍然零诊断。
  assert.equal(
    providerRule({ baseUrl: "https://api.example.com/v1" }).config.validateComplete([
      "providers",
      PROVIDER_ID,
    ]).length,
    0,
  );
});

test("createRegistryProviderConfig: warning-only is ok:true and carries the warning", () => {
  const result = createRegistryProviderConfig(
    providerRule({ baseUrl: "http://api.example.com/v1" }).config,
    ["providers", PROVIDER_ID],
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0]!.severity, "warning");
    assert.equal(hasBlockingConfigIssues(result.issues), false);
  }
});

test("createRegistryProviderConfig: blocking issue still yields ok:false with all issues", () => {
  // http baseUrl（warning）+ 缺 access（error）：两者共存于 issues，整体仍被拒绝。
  const result = createRegistryProviderConfig(
    providerRule({ baseUrl: "http://api.example.com/v1", withAccess: false }).config,
    ["providers", PROVIDER_ID],
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(hasBlockingConfigIssues(result.issues), true);
    assert.ok(result.issues.some((issue) => issue.code === "required-field-missing"));
    assert.ok(result.issues.some((issue) => issue.severity === "warning"));
  }
});

test("resolver e2e: warning-only provider stays executable, selectable and admitted", () => {
  const resolution = new ProviderConfigResolver().resolve(
    resolverInput(providerRule({ baseUrl: "http://api.example.com/v1" })),
  );

  // 诊断面包含 warning，且不含任何阻断级问题。
  const warnings = resolution.issues.filter(
    (issue) => issue.code === "plaintext-http-endpoint",
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.severity, "warning");
  assert.equal(hasBlockingConfigIssues(resolution.issues), false);

  const resolved = resolution.resolvedProviders.find((p) => p.providerId === PROVIDER_ID);
  assert.ok(resolved, "provider must be resolved");
  assert.equal(resolved.providerIssues.length, 1);
  const model = resolved.models[0]!;
  assert.equal(model.enabled, true);
  assert.equal(model.executable, true);
  assert.equal(model.selectable, true);

  // registry 仍准入该 provider，且模型随行。
  const admitted = resolution.registryProviders.find((p) => p.providerId === PROVIDER_ID);
  assert.ok(admitted, "warning-only provider must not be evicted from registry");
  assert.ok(admitted.models.some((m) => m.modelId === MODEL_ID));
});

test("resolver e2e: blocking error still evicts provider while warning coexists", () => {
  const resolution = new ProviderConfigResolver().resolve(
    resolverInput(providerRule({ baseUrl: "http://api.example.com/v1", withAccess: false })),
  );

  // error 与 warning 共存于诊断面；error 后果逐字保持。
  assert.ok(resolution.issues.some((issue) => issue.code === "required-field-missing"));
  assert.ok(resolution.issues.some((issue) => issue.code === "plaintext-http-endpoint"));

  const resolved = resolution.resolvedProviders.find((p) => p.providerId === PROVIDER_ID);
  assert.ok(resolved, "provider stays visible for settings diagnostics");
  assert.equal(resolved.models[0]!.executable, false);
  assert.equal(resolved.models[0]!.selectable, false);
  assert.equal(
    resolution.registryProviders.some((p) => p.providerId === PROVIDER_ID),
    false,
    "provider with blocking issues must be evicted from registry",
  );
});

test("resolver e2e: https provider has no new issues at all (regression guard)", () => {
  const resolution = new ProviderConfigResolver().resolve(
    resolverInput(providerRule({ baseUrl: "https://api.example.com/v1" })),
  );
  assert.equal(resolution.issues.length, 0);
  const admitted = resolution.registryProviders.find((p) => p.providerId === PROVIDER_ID);
  assert.ok(admitted, "https provider must be admitted");
  assert.deepEqual(
    admitted.models.map((m) => m.modelId),
    [MODEL_ID],
  );
  const resolved = resolution.resolvedProviders.find((p) => p.providerId === PROVIDER_ID);
  assert.ok(resolved);
  assert.equal(resolved.models[0]!.executable, true);
  assert.equal(resolved.models[0]!.selectable, true);
});
