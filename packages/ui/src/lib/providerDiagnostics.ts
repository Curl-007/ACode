import type {
  ProviderDiagnosticsResult,
  ProviderDiagnosticsTier,
} from "@acode/shared";

// i18n 文案键映射（错误码/修复动作/检查点 → 键）拆到伴生文件，避免单文件超 400 行门禁。
// re-export 让消费者仍从 `@/lib/providerDiagnostics.js` 一处导入全部纯函数（含判定与映射），
// 不必感知拆分；本文件只保留三态/fencing/档位授权/spend 等**判定**逻辑。
export * from "./providerDiagnosticsLabels.js";

/**
 * U08 Provider 诊断的 UI **纯决策逻辑**（无 React、无 I/O）。
 * 规格 packages/ui/specs/provider-diagnostics-ui.md；契约真源
 * packages/services/specs/provider-diagnostics.md 与
 * apps/acode-cli/specs/provider-doctor.md（档位/checkpoint 语义）。
 *
 * 为什么全部逻辑都放这里：本仓 ui 包无 jsdom，radix Portal 在 minimal-dom-shim 下不渲染，
 * 组件层只能用源码断言守护。因此把「三态判定 / revision fencing / 档位授权 / spend 与取消
 * 文案」全部做成纯函数，行为可被真正测试（与 lib/localDiagnosticReport.ts 同一策略）。
 * 文案键**映射**（errorCode/checkpoint/remediation → i18n 键）在伴生的
 * providerDiagnosticsLabels.ts，经上面的 re-export 合并为同一公开面。
 */

// ── R1: 保存态 vs 验证态（三态，不是两态）─────────────────────────

/**
 * 配置状态三态。
 * - `unconfigured`：还没保存，谈验证为时过早。
 * - `saved-unverified`：已落盘，但没有任何可信诊断结论。**offline/catalog 通过都停在这里**，
 *   因为轻档不能给重档背书（doctor R2）。
 * - `validated`：只有 live 档 12 点全通过（doctor `ready`）才到这里。
 */
export type ProviderConfigState = "unconfigured" | "saved-unverified" | "validated";

/**
 * 计算配置状态。
 *
 * @param saved     provider 是否已保存（保存接口返回了 providerId）
 * @param result    最近一次诊断结果（可无）
 * @param revision  **当前** ProviderSettingsView.revision
 *
 * revision fencing（R2）：只有 revision 与当前一致的结果才参与判定。用户在诊断期间编辑并
 * 保存 → revision 前进 → 旧结果对新配置**零写入**，状态退回 saved-unverified。
 * 这条是提案门槛「迟到结果对新 revision 的状态写入为 0」的实现点。
 */
export function resolveProviderConfigState(input: {
  readonly saved: boolean;
  readonly result: ProviderDiagnosticsResult | null;
  readonly revision: number;
}): ProviderConfigState {
  if (!input.saved) return "unconfigured";
  const result = input.result;
  // fencing 判据统一走 isDiagnosticsResultCurrent：状态与徽标必须同源，否则会出现
  // 「状态说未验证、界面还展示旧结论」的自相矛盾（spec U3）。
  if (!isDiagnosticsResultCurrent(result, input.revision) || !result) return "saved-unverified";
  // 只有 completed + ready 才算已验证。cancelled/failed 一律停在未验证。
  if (result.status !== "completed") return "saved-unverified";
  return result.verdict === "ready" ? "validated" : "saved-unverified";
}

/**
 * 结果是否仍然有效（可被 UI 展示）。
 * 与 resolveProviderConfigState 的 fencing 判据同源——两处必须一致，否则会出现
 * 「状态说未验证、但界面还展示旧结论」的自相矛盾。
 */
export function isDiagnosticsResultCurrent(
  result: ProviderDiagnosticsResult | null,
  revision: number,
): boolean {
  return result !== null && result.revision === revision;
}

// ── R9: 档位选择与授权 ───────────────────────────────────────────

/** 档位选项（UI 呈现顺序：offline 默认 → catalog → live）。 */
export const DIAGNOSTICS_TIER_ORDER: readonly ProviderDiagnosticsTier[] = [
  "offline",
  "catalog",
  "live",
];

/** 首次配置的默认档：offline（零网络、零费用，提案 §3.2 档位表）。 */
export const DEFAULT_DIAGNOSTICS_TIER: ProviderDiagnosticsTier = "offline";

export interface TierOption {
  readonly tier: ProviderDiagnosticsTier;
  /** i18n 键：档位名。 */
  readonly labelId: string;
  /** i18n 键：档位说明（是否联网/是否花费）。 */
  readonly descriptionId: string;
  /** 是否需要用户显式确认才能运行（catalog 联网告知、live 费用警告）。 */
  readonly requiresAcknowledgement: boolean;
  /** 确认控件的 i18n 键；不需要确认时为 undefined。 */
  readonly acknowledgementId?: string;
  /** 是否会产生真实费用（live 档）。 */
  readonly spendsBalance: boolean;
  /** 是否会联网（catalog / live 档）。 */
  readonly usesNetwork: boolean;
}

/**
 * 档位元数据单一所有者。
 *
 * 三条产品约束（提案 §3.2 档位表 + R9）在此机械化：
 * - offline：不联网、不花费、无需确认；
 * - catalog：联网告知（requiresAcknowledgement，让用户知道会出网），约零花费；
 * - live：**显式 opt-in** + 费用警告，缺确认绝不运行（spendsBalance）。
 *
 * 授权只对本次、该档位生效：这里只描述「需要哪种授权」，不落盘、不复用。
 */
export const DIAGNOSTICS_TIER_OPTIONS: readonly TierOption[] = [
  {
    tier: "offline",
    labelId: "settings.modelProvider.diagnostics.tier.offline",
    descriptionId: "settings.modelProvider.diagnostics.tier.offline.description",
    requiresAcknowledgement: false,
    spendsBalance: false,
    usesNetwork: false,
  },
  {
    tier: "catalog",
    labelId: "settings.modelProvider.diagnostics.tier.catalog",
    descriptionId: "settings.modelProvider.diagnostics.tier.catalog.description",
    requiresAcknowledgement: true,
    acknowledgementId: "settings.modelProvider.diagnostics.tier.catalog.networkNotice",
    spendsBalance: false,
    usesNetwork: true,
  },
  {
    tier: "live",
    labelId: "settings.modelProvider.diagnostics.tier.live",
    descriptionId: "settings.modelProvider.diagnostics.tier.live.description",
    requiresAcknowledgement: true,
    acknowledgementId: "settings.modelProvider.diagnostics.tier.live.costWarning",
    spendsBalance: true,
    usesNetwork: true,
  },
];

export function tierOption(tier: ProviderDiagnosticsTier): TierOption {
  // exhaustive：DIAGNOSTICS_TIER_ORDER 覆盖全部枚举值，找不到即调用方传了非法档位。
  const option = DIAGNOSTICS_TIER_OPTIONS.find((item) => item.tier === tier);
  if (!option) throw new Error(`unknown diagnostics tier: ${String(tier)}`);
  return option;
}

/**
 * 能否运行该档位。live 档必须显式 opt-in——这是「不授权就零调用」的 UI 侧门禁
 * （服务侧与 CLI 侧各有一道，三道都不依赖调用方自律）。
 */
export function canRunTier(input: {
  readonly tier: ProviderDiagnosticsTier;
  readonly acknowledged: boolean;
  readonly running: boolean;
  readonly saved: boolean;
}): boolean {
  if (!input.saved) return false; // 未保存谈不上诊断
  if (input.running) return false; // 单次执行：跑着的时候不能再点（U08-A4）
  const option = tierOption(input.tier);
  if (option.requiresAcknowledgement && !input.acknowledged) return false;
  return true;
}

// ── 结果呈现 ─────────────────────────────────────────────────────

/**
 * 运行态四态。`cancelled` 独立于 `failed`：用户主动取消不是错误（R4），
 * 呈现成失败会误导用户去修一个没坏的配置。
 */
export type DiagnosticsRunPhase = "idle" | "running" | "completed" | "cancelled" | "failed";

/** 从结果推运行态（供 UI 选文案与配色，不自行判断字符串）。 */
export function resolveRunPhase(
  result: ProviderDiagnosticsResult | null,
): DiagnosticsRunPhase {
  if (!result) return "idle";
  if (result.status === "cancelled") return "cancelled";
  if (result.status === "failed") return "failed";
  // completed：结论仍可能是不通过（verdict=failed），但「执行」是成功的。
  // 这两者分开是刻意的：执行失败 = 没测出来；结论失败 = 测出来了，配置有问题。
  return "completed";
}

/** 结论徽标三态（R1：轻档通过不等于「模型可用」）。 */
export type VerdictBadgeKind = "ready" | "tier-passed" | "failed" | "none";

export function resolveVerdictBadge(
  result: ProviderDiagnosticsResult | null,
  revision: number,
): VerdictBadgeKind {
  // 过期结果不给徽标：否则用户会以为新配置已验证（U08-A3）。
  if (!isDiagnosticsResultCurrent(result, revision)) return "none";
  if (!result || result.status !== "completed") return "none";
  return result.verdict ?? "none";
}

/**
 * 结果标题 i18n 键。
 *
 * 关键约束（R1/R5）：`tier-passed` 必须与 `ready` 呈现为**不同**文案，且 offline 档的
 * tier-passed 绝不能说成「模型可用」——提案明确「不承诺 offline 能证明模型可用」。
 */
export function resolveVerdictLabelId(input: {
  readonly badge: VerdictBadgeKind;
  readonly tier: ProviderDiagnosticsTier;
}): string {
  const { badge, tier } = input;
  if (badge === "ready") return "settings.modelProvider.diagnostics.verdict.ready";
  if (badge === "tier-passed") {
    // offline 档的通过是「本地接线没问题」，措辞必须比 catalog/live 更保守。
    return tier === "offline"
      ? "settings.modelProvider.diagnostics.verdict.offlinePassed"
      : "settings.modelProvider.diagnostics.verdict.tierPassed";
  }
  if (badge === "failed") return "settings.modelProvider.diagnostics.verdict.failed";
  return "settings.modelProvider.diagnostics.verdict.none";
}

/**
 * 是否展示「已花费」提示。
 * 只有真的产生计费调用时才提示；spend 缺席 = 花费未知（取消/未跑起来），
 * 此时不能说「没花钱」也不能编造数字（R4 的诚实基线）。
 */
export function resolveSpendNotice(input: {
  readonly spend: ProviderDiagnosticsResult["spend"];
}): { readonly kind: "none" | "charged" | "unknown" } {
  if (!input.spend) return { kind: "unknown" };
  return input.spend.billableCalls > 0 ? { kind: "charged" } : { kind: "none" };
}

/**
 * 取消后的文案选择：绝不承诺退费（R4 / U08-A3）。
 * - 花费未知 → 「已停止；已发生的调用无法撤销」（不提金额，因为不知道）。
 * - 已知有计费调用 → 如实告知次数。
 * - 已知零调用 → 可以说「未产生调用」，因为这是事实而非承诺。
 */
export function resolveCancelNoticeId(input: {
  readonly spend: ProviderDiagnosticsResult["spend"];
}): string {
  const notice = resolveSpendNotice({ spend: input.spend });
  const PREFIX = "settings.modelProvider.diagnostics.cancelNotice";
  if (notice.kind === "none") return `${PREFIX}.noCharges`;
  // charged 与 unknown 用同一句「已发生的调用无法撤销」：两者都不能声称退费。
  return `${PREFIX}.irrevocable`;
}
