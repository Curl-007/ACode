import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS,
  PROVIDER_DIAGNOSTICS_REASON_CODES,
  PROVIDER_DIAGNOSTICS_REMEDIATION_ACTIONS,
  PROVIDER_DIAGNOSTICS_ZERO_SPEND,
  type ProviderDiagnosticsReasonCode,
  type ProviderDiagnosticsResult,
  type ProviderDiagnosticsTier,
} from "@acode/shared";
import {
  DEFAULT_DIAGNOSTICS_TIER,
  DIAGNOSTICS_TIER_OPTIONS,
  canRunTier,
  checkpointLabelId,
  checkpointStatusLabelId,
  checkpointStatusVariant,
  diagnosticsErrorCodeLabelId,
  isDiagnosticsResultCurrent,
  remediationActionView,
  resolveCancelNoticeId,
  resolveProviderConfigState,
  resolveRunPhase,
  resolveSpendNotice,
  resolveVerdictBadge,
  resolveVerdictLabelId,
  tierOption,
} from "../src/lib/providerDiagnostics.js";

/**
 * U08 UI 决策逻辑测试（specs/provider-diagnostics-ui.md）。
 *
 * ui 包无 jsdom、radix Portal 在 minimal-dom-shim 下不渲染，因此所有判定逻辑都在
 * src/lib/providerDiagnostics.ts 的纯函数里，本文件覆盖其**行为**；组件接线（首配保存后
 * 不直接跳走、重试不经保存接口、nextStepCommands 只展示不执行）用源码契约断言守护
 * ——与 test/modelProviderDiscovery.test.ts 同一口径。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const LOGIN_FORM_PATH = resolve(HERE, "../src/login/LoginApiKeyForm.tsx");
const PANEL_PATH = resolve(HERE, "../src/components/ProviderDiagnosticsPanel.tsx");
const HOOK_PATH = resolve(HERE, "../src/hooks/useProviderDiagnostics.ts");
const LIB_PATH = resolve(HERE, "../src/lib/providerDiagnostics.ts");
// 刻意不读 i18n locale 文件：en-US.ts / zh-CN.ts 由并行的其它改动持有，
// 本测试只断言「键名形态合法」，键的**存在性**由 lead 合并 locale 时对照（见交付说明）。

const read = (path: string): string => readFileSync(path, "utf8");

function allPassed() {
  return PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS.map((id) => ({ id, status: "passed" as const }));
}

function result(overrides: Partial<ProviderDiagnosticsResult> = {}): ProviderDiagnosticsResult {
  return {
    requestId: "r1",
    providerId: "zai",
    revision: 5,
    tier: "live",
    status: "completed",
    verdict: "ready",
    checkpoints: allPassed(),
    remediationActions: ["retry-diagnostics"],
    nextStepCommands: [],
    spend: { ...PROVIDER_DIAGNOSTICS_ZERO_SPEND },
    blockedNetworkCalls: 0,
    startedAt: "t0",
    finishedAt: "t1",
    ...overrides,
  };
}

// ── U2: 三态可见地区分 ───────────────────────────────────────────
test("U2: 未保存 = unconfigured，不看任何诊断结果", () => {
  assert.equal(
    resolveProviderConfigState({ saved: false, result: result(), revision: 5 }),
    "unconfigured",
    "未保存时即使有 ready 结果也不能声称已验证",
  );
});

test("U2: 已保存但无结果 = saved-unverified（不是 validated）", () => {
  assert.equal(
    resolveProviderConfigState({ saved: true, result: null, revision: 5 }),
    "saved-unverified",
  );
});

test("U2: 只有 live 档 ready 才是 validated", () => {
  assert.equal(
    resolveProviderConfigState({ saved: true, result: result(), revision: 5 }),
    "validated",
  );
  // offline/catalog 档通过（tier-passed）**不进入** validated——轻档不越档背书（R1）。
  for (const tier of ["offline", "catalog"] as ProviderDiagnosticsTier[]) {
    assert.equal(
      resolveProviderConfigState({
        saved: true,
        result: result({ tier, verdict: "tier-passed" }),
        revision: 5,
      }),
      "saved-unverified",
      `${tier} 档 tier-passed 不得呈现为已验证`,
    );
  }
  // live 档 tier-passed（有 skipped）同样不算已验证。
  assert.equal(
    resolveProviderConfigState({
      saved: true,
      result: result({ tier: "live", verdict: "tier-passed" }),
      revision: 5,
    }),
    "saved-unverified",
  );
});

test("U3: revision fencing——旧 revision 的结果对新配置零写入（U08-A3）", () => {
  const stale = result({ revision: 5, verdict: "ready" });
  // 用户改了配置，revision 前进到 6：旧的 ready 结果必须被丢弃。
  assert.equal(resolveProviderConfigState({ saved: true, result: stale, revision: 6 }), "saved-unverified");
  assert.equal(isDiagnosticsResultCurrent(stale, 6), false);
  assert.equal(resolveVerdictBadge(stale, 6), "none", "过期结果不得给徽标");
  // 匹配时正常采纳。
  assert.equal(isDiagnosticsResultCurrent(stale, 5), true);
  assert.equal(resolveVerdictBadge(stale, 5), "ready");
});

test("U3: fencing 判据单一来源——状态与徽标对同一份过期结果必须一致", () => {
  // 行为断言比源码切片更可靠：真正要防的是「状态说未验证、徽标却还展示旧结论」。
  // 源码层面的同源由 lib 内两处都调用 isDiagnosticsResultCurrent 保证（见下条断言）。
  const stale = result({ revision: 5, verdict: "ready" });
  for (const currentRevision of [5, 6, 7]) {
    const state = resolveProviderConfigState({ saved: true, result: stale, revision: currentRevision });
    const badge = resolveVerdictBadge(stale, currentRevision);
    const current = isDiagnosticsResultCurrent(stale, currentRevision);
    if (currentRevision === 5) {
      assert.equal(current, true);
      assert.equal(state, "validated");
      assert.equal(badge, "ready");
    } else {
      // 过期：两者必须**同时**退回「无结论」，不允许一个说未验证、另一个还画徽标。
      assert.equal(current, false);
      assert.equal(state, "saved-unverified");
      assert.equal(badge, "none");
    }
  }
  // 源码层：两处判定都必须走同一个 helper（防止日后有人把其中一处改回内联比较而漂移）。
  const source = read(LIB_PATH);
  const stateFn = source.slice(
    source.indexOf("export function resolveProviderConfigState"),
    source.indexOf("export function isDiagnosticsResultCurrent"),
  );
  assert.match(stateFn, /isDiagnosticsResultCurrent\(/, "resolveProviderConfigState 必须复用 fencing helper");
  const badgeFn = source.slice(source.indexOf("export function resolveVerdictBadge"));
  assert.match(badgeFn, /isDiagnosticsResultCurrent\(/, "resolveVerdictBadge 必须复用 fencing helper");
});

test("U2: cancelled/failed 结果不进入 validated", () => {
  for (const status of ["cancelled", "failed"] as const) {
    assert.equal(
      resolveProviderConfigState({
        saved: true,
        result: result({ status, verdict: undefined, errorCode: "cancelled" }),
        revision: 5,
      }),
      "saved-unverified",
      `${status} 不得呈现为已验证`,
    );
    // verdict 必须缺席（契约 superRefine 保证），否则会被误读成结论。
    assert.equal(resolveVerdictBadge(result({ status, verdict: undefined, errorCode: "cancelled" }), 5), "none");
  }
});

// ── U5/R9: 档位授权 ─────────────────────────────────────────────
test("U5: 默认档是 offline，且 offline 不联网不花费不需确认", () => {
  assert.equal(DEFAULT_DIAGNOSTICS_TIER, "offline");
  const offline = tierOption("offline");
  assert.equal(offline.usesNetwork, false);
  assert.equal(offline.spendsBalance, false);
  assert.equal(offline.requiresAcknowledgement, false);
});

test("U5: catalog 需联网告知、live 需显式 opt-in 且标记花费（U08-A1 的档位元数据断言）", () => {
  const catalog = tierOption("catalog");
  assert.equal(catalog.usesNetwork, true);
  assert.equal(catalog.spendsBalance, false, "catalog 约零花费，不得标成计费");
  assert.equal(catalog.requiresAcknowledgement, true);
  assert.ok(catalog.acknowledgementId, "catalog 必须有联网告知文案键");

  const live = tierOption("live");
  assert.equal(live.usesNetwork, true);
  assert.equal(live.spendsBalance, true, "live 会产生费用，必须标记");
  assert.equal(live.requiresAcknowledgement, true);
  assert.ok(live.acknowledgementId, "live 必须有费用警告文案键");
  assert.notEqual(catalog.acknowledgementId, live.acknowledgementId, "联网告知与费用警告必须分开");
});

test("U5: 三个档位选项覆盖全部 tier 且顺序为 offline → catalog → live", () => {
  assert.deepEqual(
    DIAGNOSTICS_TIER_OPTIONS.map((item) => item.tier),
    ["offline", "catalog", "live"],
  );
});

test("U5: tierOption 对非法档位 fail-loud（不静默回落到某一档）", () => {
  assert.throws(() => tierOption("full" as ProviderDiagnosticsTier));
});

test("U4: canRunTier——未保存/运行中/未确认授权都不给运行", () => {
  const base = { tier: "offline" as ProviderDiagnosticsTier, acknowledged: false, running: false, saved: true };
  assert.equal(canRunTier(base), true, "offline 无需确认即可运行");
  // U08-A4：运行中禁用，双击不产生第二次执行。
  assert.equal(canRunTier({ ...base, running: true }), false);
  // 未保存谈不上诊断。
  assert.equal(canRunTier({ ...base, saved: false }), false);
  // catalog/live 未确认 → 不可运行（U5/R9）。
  assert.equal(canRunTier({ ...base, tier: "catalog" }), false);
  assert.equal(canRunTier({ ...base, tier: "live" }), false);
  assert.equal(canRunTier({ ...base, tier: "catalog", acknowledged: true }), true);
  assert.equal(canRunTier({ ...base, tier: "live", acknowledged: true }), true);
});

// ── U6/R5: skipped 与 failed 可区分 ─────────────────────────────
test("U6: 四态映射到四个不同文案键（U08-A5）", () => {
  const ids = new Set(
    (["passed", "failed", "skipped", "blocked"] as const).map(checkpointStatusLabelId),
  );
  assert.equal(ids.size, 4, "四态文案必须互不相同");
});

test("U6: skipped/blocked 的视觉变体不等于 failed（不把「没检查」画成红叉）", () => {
  assert.notEqual(checkpointStatusVariant("skipped"), checkpointStatusVariant("failed"));
  assert.notEqual(checkpointStatusVariant("blocked"), checkpointStatusVariant("failed"));
  // skipped 与 blocked 同为「未得出结论」，用同一弱化样式。
  assert.equal(checkpointStatusVariant("skipped"), checkpointStatusVariant("blocked"));
  // 只用 Badge 既有 variant（DESIGN.md：不新造样式）。
  for (const status of ["passed", "failed", "skipped", "blocked"] as const) {
    assert.ok(
      ["secondary", "destructive", "outline"].includes(checkpointStatusVariant(status)),
      `${status} 必须用既有 Badge variant`,
    );
  }
});

test("U6: 12 个检查点 id 都有文案键，未知 id fail-loud（契约漂移不静默显示空白）", () => {
  for (const id of PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS) {
    assert.ok(checkpointLabelId(id).length > 0, `${id} 缺文案键`);
  }
  assert.throws(() => checkpointLabelId("not_a_checkpoint"));
});

// ── R6: 错误码 → i18n 键全映射 ──────────────────────────────────
test("R6: 每个稳定错误码都映射到一个 i18n 键（闭集无遗漏，exhaustive switch 生效）", () => {
  const ids = PROVIDER_DIAGNOSTICS_REASON_CODES.map(diagnosticsErrorCodeLabelId);
  assert.equal(ids.length, PROVIDER_DIAGNOSTICS_REASON_CODES.length);
  // 不允许落到 undefined/空串（否则 UI 显示空白）。
  assert.ok(ids.every((id) => typeof id === "string" && id.length > 0));
});

test("U08-A2: 密钥被拒 / 凭据缺失 / 目录为空三者映射到三个不同文案键", () => {
  const distinct = new Set(
    (["credential-rejected", "credential-missing", "catalog-empty"] as ProviderDiagnosticsReasonCode[]).map(
      diagnosticsErrorCodeLabelId,
    ),
  );
  assert.equal(distinct.size, 3, "三种故障必须有三种不同文案");
  // 凭据不可解密（blocked）与被端点拒（failed）也不同：前者是「无法验证」，后者是「密钥错了」。
  assert.notEqual(
    diagnosticsErrorCodeLabelId("credential-undecryptable"),
    diagnosticsErrorCodeLabelId("credential-rejected"),
  );
});

test("R6: 修复动作全部映射到 i18n 键 + 闭集 kind（无「执行命令」kind）", () => {
  const kinds = new Set<string>();
  for (const action of PROVIDER_DIAGNOSTICS_REMEDIATION_ACTIONS) {
    const view = remediationActionView(action);
    assert.equal(view.action, action);
    assert.ok(view.labelId.length > 0, `${action} 缺文案键`);
    kinds.add(view.kind);
  }
  // U8：动作 kind 里不得出现「执行命令」类别——nextStepCommands 只能展示。
  for (const forbidden of ["execute", "run-command", "shell", "spawn"]) {
    assert.equal(kinds.has(forbidden), false, `修复动作不得包含执行命令的 kind: ${forbidden}`);
  }
});

// ── U7/R4: 取消文案不承诺退费 ────────────────────────────────────
test("U7: 取消文案——花费未知/已计费都说「无法撤销」，只有确认零调用才说未产生", () => {
  const irrevocable = "settings.modelProvider.diagnostics.cancelNotice.irrevocable";
  const noCharges = "settings.modelProvider.diagnostics.cancelNotice.noCharges";
  // spend 缺席 = 花费未知 → 不能说没花钱。
  assert.equal(resolveCancelNoticeId({ spend: undefined }), irrevocable);
  // 已知有计费调用 → 不能说退费，只能说无法撤销。
  assert.equal(
    resolveCancelNoticeId({ spend: { ...PROVIDER_DIAGNOSTICS_ZERO_SPEND, billableCalls: 2 } }),
    irrevocable,
  );
  // 已知零调用 → 可以如实说未产生。
  assert.equal(resolveCancelNoticeId({ spend: { ...PROVIDER_DIAGNOSTICS_ZERO_SPEND } }), noCharges);
  // catalogCalls>0 但 billableCalls=0 不算「计费」，仍属未产生计费调用。
  assert.equal(
    resolveCancelNoticeId({ spend: { ...PROVIDER_DIAGNOSTICS_ZERO_SPEND, catalogCalls: 1 } }),
    noCharges,
  );
});

test("U7: 取消是独立运行态，不并入 failed（R4）", () => {
  assert.equal(resolveRunPhase(result({ status: "cancelled", verdict: undefined, errorCode: "cancelled" })), "cancelled");
  assert.equal(resolveRunPhase(result({ status: "failed", verdict: undefined, errorCode: "execution-failed" })), "failed");
  assert.equal(resolveRunPhase(result()), "completed");
  assert.equal(resolveRunPhase(null), "idle");
  // completed 但结论不通过 → 运行态仍是 completed（执行成功，结论失败是两件事）。
  assert.equal(
    resolveRunPhase(result({ verdict: "failed", errorCode: "credential-rejected" })),
    "completed",
  );
});

test("R4: spend 三态——none/charged/unknown 可区分，未知不得当成零", () => {
  assert.deepEqual(resolveSpendNotice({ spend: undefined }), { kind: "unknown" });
  assert.deepEqual(resolveSpendNotice({ spend: { ...PROVIDER_DIAGNOSTICS_ZERO_SPEND } }), { kind: "none" });
  assert.deepEqual(
    resolveSpendNotice({ spend: { ...PROVIDER_DIAGNOSTICS_ZERO_SPEND, billableCalls: 1 } }),
    { kind: "charged" },
  );
});

// ── R1: verdict 文案 offline 更保守 ──────────────────────────────
test("R1: offline 档 tier-passed 用独立的保守文案，不复用 catalog/live 的 tierPassed", () => {
  const offlineLabel = resolveVerdictLabelId({ badge: "tier-passed", tier: "offline" });
  const catalogLabel = resolveVerdictLabelId({ badge: "tier-passed", tier: "catalog" });
  assert.notEqual(offlineLabel, catalogLabel, "offline 通过不得说成与 catalog 通过同一件事");
  assert.ok(offlineLabel.includes("offlinePassed"), "offline 档应有专属文案键");
  // 提案：不承诺 offline 能证明模型可用 → offline 通过不得出 ready 文案。
  assert.notEqual(offlineLabel, resolveVerdictLabelId({ badge: "ready", tier: "offline" }));
});

test("R1: 徽标四态（ready/tier-passed/failed/none）互不相同", () => {
  assert.equal(resolveVerdictBadge(result(), 5), "ready");
  assert.equal(resolveVerdictBadge(result({ tier: "offline", verdict: "tier-passed" }), 5), "tier-passed");
  assert.equal(resolveVerdictBadge(result({ verdict: "failed", errorCode: "x" as never }), 5), "failed");
  assert.equal(resolveVerdictBadge(null, 5), "none");
});

// ── U8: 隐私 ────────────────────────────────────────────────────
test("U8: lib 不读取任何凭据数据，UI 可见文本全部由 i18n 键生成", () => {
  const source = read(LIB_PATH);
  // 断言的是**数据访问**，不是单词出现：`openApiKeySettings` 是导航目标名（i18n 键），
  // 完全合法；真正要挡的是「从结果/配置里读凭据字段」。
  for (const forbidden of [
    /\.apiKey\b/,
    /\.authorization\b/i,
    /\.credentialRef\b/,
    /\.secret\b/,
    /\.accessToken\b/,
    /\.token\b/,
    /\bkeyHash\b/,
  ]) {
    assert.equal(forbidden.test(source), false, `lib 不得读取凭据数据: ${forbidden}`);
  }
  // 结果里的 detail/label 自由文本不被 lib 消费（DTO 结构性无此字段）。
  assert.equal(/\.detail\b/.test(source), false);
  assert.equal(/\.label\b/.test(source), false);
  // 行为断言：所有 i18n 键都是**静态常量形态**（点分标识符），不夹带用户数据。
  // 这比源码扫描 ${} 更准——lib 里的插值只出现在契约漂移的 throw 文案里（tierOption /
  // checkpointLabelId），那是开发者错误信息，不是 UI 可见文本。
  const KEY_SHAPE = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/;
  for (const code of PROVIDER_DIAGNOSTICS_REASON_CODES) {
    assert.match(diagnosticsErrorCodeLabelId(code), KEY_SHAPE, `${code} 的文案键必须是静态常量形态`);
  }
  for (const action of PROVIDER_DIAGNOSTICS_REMEDIATION_ACTIONS) {
    assert.match(remediationActionView(action).labelId, KEY_SHAPE);
  }
  for (const id of PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS) {
    assert.match(checkpointLabelId(id), KEY_SHAPE);
  }
});

test("U8: nextStepCommands 在 Panel 里只出现在展示位，不经任何执行 API", () => {
  const panel = read(PANEL_PATH);
  // 只渲染成 <code>，不进 window.acode / exec / spawn / openExternal。
  const commandBlock = panel.slice(panel.indexOf("nextStepCommands.length"));
  assert.match(commandBlock, /<code/);
  for (const forbidden of ["exec(", "spawn(", "window.acode", "openExternal", "eval(", "child_process"]) {
    assert.equal(panel.includes(forbidden), false, `Panel 不得出现执行类 API: ${forbidden}`);
  }
});

// ── 组件接线（源码契约断言；本仓无 jsdom）──────────────────────────
test("U08-A1: 首配保存成功后不直接跳走，而是落到「已保存、尚未验证」态", () => {
  const form = read(LOGIN_FORM_PATH);
  // 保存路径不再直接 await onSaved()，而是记下 providerId + revision。
  assert.match(form, /setSavedProvider\(\{ providerId: created\.providerId, revision: created\.view\.revision \}\)/);
  // 保存成功后渲染诊断面板。
  assert.match(form, /if \(savedProvider\) \{/);
  assert.match(form, /<ProviderDiagnosticsPanel/);
  // 「继续」仍可跳过验证（提案 §3.6：可保持已保存未验证）。
  assert.match(form, /onClick=\{\(\) => void onSaved\(\)\}/);
});

test("U08-A4: 重试不经保存接口——面板 run 只调 runProviderDiagnostics", () => {
  const form = read(LOGIN_FORM_PATH);
  const hook = read(HOOK_PATH);
  // 保存后视图里不得再出现 createPersonalProvider（诊断/重试绝不重新创建 provider）。
  const savedView = form.slice(form.indexOf("if (savedProvider) {"));
  assert.equal(savedView.includes("createPersonalProvider"), false, "保存后视图不得再创建 provider");
  // hook 只调诊断两个方法，不调保存类方法。
  assert.match(hook, /runProviderDiagnostics\(/);
  assert.match(hook, /cancelProviderDiagnostics\(/);
  for (const forbidden of ["createPersonalProvider", "savePersonalProviderOverlay", "addPersonalModel"]) {
    assert.equal(hook.includes(forbidden), false, `诊断 hook 不得调用写入方法: ${forbidden}`);
  }
});

test("U4: hook 在飞期间忽略重复 run（单次执行的 UI 侧门禁）", () => {
  const hook = read(HOOK_PATH);
  assert.match(hook, /if \(inflightRequestIdRef\.current !== null\) return;/);
  // 结果采纳前校验 requestId 仍是本次的（防止取消/新请求后旧回包被采纳）。
  assert.match(hook, /inflightRequestIdRef\.current !== nextRequestIdValue/);
  // fencing 在采纳前执行。
  assert.match(hook, /isDiagnosticsResultCurrent\(outcome, revisionAtStart\)/);
});

test("U3: hook 每次 run 生成新 requestId 并快照发起时的 revision", () => {
  const hook = read(HOOK_PATH);
  assert.match(hook, /const nextRequestIdValue = nextRequestId\(\)/);
  assert.match(hook, /const revisionAtStart = target\.revision/);
  // 请求带的是发起时快照的 revision，不是渲染时的最新值。
  assert.match(hook, /revision: revisionAtStart/);
  // live 档才带 liveOptIn（授权只对本次、该档位生效）。
  assert.match(hook, /tier === "live" \? \{ liveOptIn: input\.acknowledged \} : \{\}/);
});

test("U1: 组件层不含判定逻辑——Panel 无 tier/revision/errorCode 的分支", () => {
  const panel = read(PANEL_PATH);
  // 判定全在 lib：Panel 只调 lib 的纯函数，不自己比较 revision、不自己 switch errorCode。
  assert.equal(/result\.revision\s*[!=]==/.test(panel), false, "Panel 不得自己比较 revision");
  assert.equal(/errorCode\s*===\s*"/.test(panel), false, "Panel 不得自己判定 errorCode");
  assert.equal(/tier\s*===\s*"(offline|catalog|live)"/.test(panel), false, "Panel 不得自己判定 tier 语义");
  // 但确实调用了 lib 的判定函数（证明逻辑在正确的层）。
  for (const fn of [
    "resolveProviderConfigState",
    "resolveRunPhase",
    "resolveVerdictBadge",
    "canRunTier",
    "diagnosticsErrorCodeLabelId",
    "remediationActionView",
    "checkpointStatusLabelId",
    "checkpointStatusVariant",
    "resolveCancelNoticeId",
  ]) {
    assert.match(panel, new RegExp(fn), `Panel 应调用 lib 的 ${fn}`);
  }
});

test("R8: 日志与组件都不写凭据（隐私门槛 = 0）", () => {
  const hook = read(HOOK_PATH);
  const panel = read(PANEL_PATH);
  const form = read(LOGIN_FORM_PATH);
  // hook 的日志上下文只带标识字段，不带 apiKey。
  const logBlocks = hook.match(/logger\.warn\([\s\S]*?\);/g) ?? [];
  assert.ok(logBlocks.length > 0, "hook 应有失败日志");
  for (const block of logBlocks) {
    assert.equal(/apiKey|authorization|secret/i.test(block), false, `日志不得含凭据字段: ${block.slice(0, 80)}`);
  }
  // Panel 完全不记日志（展示层不该有副作用），也不出现凭据字段名。
  assert.equal(/logger\.|console\./.test(panel), false, "Panel 不得直接记日志");
  assert.equal(/apiKey|authorization|bearer/i.test(panel), false);
  // 表单仍用 logger（既有纪律），但保存后的诊断视图不含裸 console。
  assert.equal(/console\.log/.test(form), false);
});

test("首配与设置页共用同一个 Panel（不出现两套状态文案）", () => {
  const form = read(LOGIN_FORM_PATH);
  const card = read(resolve(HERE, "../src/settings/ProviderDiagnosticsCard.tsx"));
  // Panel 放在中立的 components/ 下：它是两个 feature（login 首配 + settings 设置页）共用件，
  // 放 login/ 会让 settings 跨 feature 目录反向 import login，形成耦合（components/ 是仓库
  // 既有的跨 feature 共享组件归属，如 TeamApprovalActions/TeamStatusSummary）。
  assert.match(form, /from "@\/components\/ProviderDiagnosticsPanel\.js"/);
  assert.match(card, /from "@\/components\/ProviderDiagnosticsPanel\.js"/);
  // 反向守护：不得再从 login/ 路径 import Panel（防止回退成 settings→login 跨 feature import）。
  assert.equal(/from "@\/login\/ProviderDiagnosticsPanel/.test(card), false);
  // 设置页卡片自己算 hook，不经 props 穿透（避免加深 900+ 行组件的耦合面）。
  assert.match(card, /useProviderDiagnostics\(\{ providerId, revision \}\)/);
});

test("设置页入口拿到 providerId 与 settingsRevision（诊断需要 revision 做 fencing）", () => {
  const card = read(resolve(HERE, "../src/settings/model-provider-section/InlineEditableProviderCard.tsx"));
  assert.match(card, /<ProviderDiagnosticsCard/);
  assert.match(card, /providerId=\{provider\.providerId\}/);
  assert.match(card, /revision=\{settingsRevision \?\? 0\}/);
});
