export const SPEC_REF = "apps/acode-cli/specs/prompt-eval-runner.md";

/** dist 新鲜度守护（spec §R2，试点教训：陈旧 dist = 测旧提示词 = 基线保真不成立）。 */
export function checkDistFreshness(distMtimeMs, srcLatestMtimeMs) {
  if (srcLatestMtimeMs > distMtimeMs) {
    return {
      ok: false,
      reason:
        `CLI dist is older than packages src (dist ${new Date(distMtimeMs).toISOString()} < src ${new Date(srcLatestMtimeMs).toISOString()}). ` +
        `Rebuild first: cd apps/acode-cli && ../../node_modules/.bin/turbo run build --filter="@acode/cli..."`,
    };
  }
  return { ok: true };
}

/** judgeFingerprint（spec §R4）：指纹不同的报告不得互算 delta。 */
export function judgeFingerprintFor(mode, { model, endpointHost } = {}) {
  if (mode === "live")
    return { mode, model: model ?? "unknown", ...(endpointHost ? { endpointHost } : {}) };
  if (mode === "operator") return { mode, model: model ?? "unspecified" };
  return { mode: "pending" };
}

/** 报告形状（spec §R5）：scoreScenario 报告 + 采集元数据。 */
export function buildReport({ scenarioId, runId, status, judgeFingerprint, collection, score }) {
  return {
    spec: SPEC_REF,
    scenarioId,
    runId,
    status, // "awaiting-judgement" | "scored"
    judgeFingerprint,
    collection,
    ...(score ?? {}),
  };
}
