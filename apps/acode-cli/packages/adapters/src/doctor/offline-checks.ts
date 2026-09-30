// ============================================================
// Provider Doctor offline 档检查点（J3-1 / spec R3 #1-#6）
// 机制参照 jcode (MIT, github.com/1jehuang/jcode) crates/jcode-provider-doctor，自撰实现。
// ============================================================
//
// 六个检查点全部只读本地事实：配置源、schema 准入、端点形态、凭据可解密、
// 目录声明、模型路由。**零网络**（凭据解密是本地文件 + 本地密钥）。

import { basename } from "node:path";
import { isBlockingConfigIssue } from "@acode/provider";
import type { ProviderDoctorCheckRecorder } from "./check-recorder.js";
import { resolveProviderDoctorAccountAccess } from "./credential-probe.js";
import { timedRun } from "./internal.js";
import { inspectProviderEndpoint } from "./endpoint-policy.js";
import { listModelIds } from "./report-assembly.js";
import type {
  ProviderDoctorModelFacts,
  ProviderDoctorProviderFacts,
  ProviderDoctorRegistrySnapshot,
  ProviderDoctorRunInput,
} from "./types.js";

const KNOWN_API_TYPES = new Set([
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
]);

export function recordConfigSourceCheck(
  recorder: ProviderDoctorCheckRecorder,
  snapshot: ProviderDoctorRegistrySnapshot,
): void {
  const sourceLabels = [
    snapshot.sources.acodeBuiltinFilePath
      ? `Built-in=${basename(snapshot.sources.acodeBuiltinFilePath)}`
      : undefined,
    snapshot.sources.personalFilePath
      ? `Personal=${basename(snapshot.sources.personalFilePath)}`
      : undefined,
  ].filter((value): value is string => Boolean(value));
  const issueCount = snapshot.issues?.length ?? 0;
  if (sourceLabels.length === 0) {
    recorder.set(
      "config_sources_loaded",
      "failed",
      `未解析到任何 provider 配置源${issueCount > 0 ? `（配置层 issue ${issueCount} 条）` : ""}`,
    );
    return;
  }
  recorder.set(
    "config_sources_loaded",
    "passed",
    `配置源 ${sourceLabels.join("，")}；revision=${truncateRevision(snapshot.revision)}${
      issueCount > 0 ? `；配置层 issue ${issueCount} 条（全快照，含其他 provider）` : ""
    }`,
  );
}

/**
 * revision 是多层来源的摘要串（形如 `["acode-builtin:30:<sha>","<sha>"]`）：原样打印会把
 * 整行详情挤爆，也不可读。这里去掉 JSON 包装并只留可对照的前缀。
 */
function truncateRevision(revision: string): string {
  const trimmed = revision.replace(/[[\]"]/g, "").trim();
  return trimmed.length <= 32 ? trimmed : `${trimmed.slice(0, 32)}…`;
}

export function recordSchemaCheck(
  recorder: ProviderDoctorCheckRecorder,
  provider: ProviderDoctorProviderFacts,
): void {
  // 「阻断级」判定走 provider 包的唯一门控谓词，不在诊断里手写 severity 过滤。
  const blocking = provider.issues.filter((issue) => isBlockingConfigIssue(issue));
  const warnings = provider.issues.filter((issue) => !isBlockingConfigIssue(issue));
  if (blocking.length > 0) {
    recorder.set(
      "provider_schema_valid",
      "failed",
      `${blocking.length} 条阻断级 schema 问题: ${formatIssues(blocking)}`,
    );
    return;
  }
  recorder.set(
    "provider_schema_valid",
    "passed",
    warnings.length > 0
      ? `schema 准入通过，另有 ${warnings.length} 条 warning（${warnings
          .slice(0, 3)
          .map((issue) => issue.code)
          .join(", ")}）`
      : "schema 准入通过（无阻断级 issue）",
  );
}

export function recordEndpointShapeCheck(
  recorder: ProviderDoctorCheckRecorder,
  provider: ProviderDoctorProviderFacts,
  verdict: ReturnType<typeof inspectProviderEndpoint>,
): void {
  const apiType = provider.apiType;
  if (!apiType || !KNOWN_API_TYPES.has(apiType)) {
    recorder.set(
      "endpoint_shape_valid",
      "failed",
      `api.type 不是已知协议: ${apiType ?? "缺席"}（应为 anthropic-messages / openai-chat-completions / openai-responses）`,
    );
    return;
  }
  if (!verdict.ok) {
    recorder.set("endpoint_shape_valid", "failed", verdict.reason);
    return;
  }
  recorder.set(
    "endpoint_shape_valid",
    "passed",
    `api.type=${apiType}，host=${verdict.host}${
      verdict.plaintextHttp ? "；警告：明文 http 端点会把 API Key 与对话内容暴露给链路中间节点" : ""
    }`,
  );
}

export async function recordCredentialCheck(
  recorder: ProviderDoctorCheckRecorder,
  provider: ProviderDoctorProviderFacts,
  input: ProviderDoctorRunInput,
  modelId: string | undefined,
): Promise<void> {
  // 账号型 provider 的请求身份（评审 J3 修复）：探测端口要把它交给接线的 headers port，
  // 否则「已登录且凭据可解密」会被判成解密失败 → credential_available=blocked，
  // 并连带把 catalog/live 档的 #8-#12 全部 skip（spec R3 #4 要求 passed）。
  const accountAccess = resolveProviderDoctorAccountAccess(provider.providerConfig);
  const { result: credential } = await timedRun(() =>
    input.credentials.probe({
      providerId: provider.providerId,
      access: provider.access,
      ...(modelId ? { modelId } : {}),
      ...(accountAccess ? { accountAccess } : {}),
    }),
  );
  const detail = `${credential.detail}（来源=${credential.source}）`;
  if (credential.status === "available") {
    recorder.set("credential_available", "passed", detail);
    return;
  }
  // 凭据库不可用 = 诊断无法证明，记 blocked；引用悬空/未配置 = 事实性缺失，记 failed。
  recorder.set(
    "credential_available",
    credential.status === "undecryptable" ? "blocked" : "failed",
    detail,
  );
}

export function recordCatalogDeclaredCheck(
  recorder: ProviderDoctorCheckRecorder,
  provider: ProviderDoctorProviderFacts,
): void {
  if (provider.models.length === 0) {
    recorder.set("catalog_models_declared", "failed", "Registry 未给该 provider 发布任何模型");
    return;
  }
  recorder.set(
    "catalog_models_declared",
    "passed",
    `Registry 发布 ${provider.models.length} 个模型（${listModelIds(provider.models)}）`,
  );
}

export function recordModelRouteCheck(
  recorder: ProviderDoctorCheckRecorder,
  provider: ProviderDoctorProviderFacts,
  modelId: string | undefined,
  modelFacts: ProviderDoctorModelFacts | undefined,
): void {
  if (!modelId) {
    recorder.set(
      "model_route_resolved",
      "failed",
      "没有可诊断的目标模型（目录为空或未指定 --model）",
    );
    return;
  }
  if (!modelFacts) {
    recorder.set(
      "model_route_resolved",
      "failed",
      `模型 ${modelId} 不在该 provider 的目录内（可选: ${listModelIds(provider.models)}）`,
    );
    return;
  }
  const blocking = modelFacts.issues.filter((issue) => isBlockingConfigIssue(issue));
  if (blocking.length > 0) {
    recorder.set(
      "model_route_resolved",
      "failed",
      `模型 ${modelId} 有 ${blocking.length} 条阻断级配置问题: ${formatIssues(blocking)}`,
    );
    return;
  }
  if (modelFacts.reasoningLevels.length === 0) {
    recorder.set(
      "model_route_resolved",
      "failed",
      `模型 ${modelId} 没有声明合法推理档位，无法构造请求`,
    );
    return;
  }
  recorder.set(
    "model_route_resolved",
    "passed",
    `目标模型 ${modelId}；档位 ${modelFacts.reasoningLevels.join("/")}；maxOutputTokens≤${modelFacts.maxOutputTokens}；supportsToolCall=${modelFacts.supportsToolCall}`,
  );
}

function formatIssues(issues: readonly { code: string; path: readonly string[] }[]): string {
  return issues
    .slice(0, 3)
    .map((issue) => `${issue.code}@${issue.path.join(".")}`)
    .join(", ");
}
