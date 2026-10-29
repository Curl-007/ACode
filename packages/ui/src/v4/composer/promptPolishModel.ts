
import { type V4WorkspaceModelMessage } from "@acode/shared/acode-protocol-v4";
import {
  normalizePromptPolishModelSelection,
  type PromptPolishModelSelection,
} from "@/lib/promptPolishPreferences.js";

// 提示词润色纯逻辑（specs/prompt-polish.md 产品规则 2/3/5）：模型解析阶梯、
// 可用性判定、请求预检与指令构造。hook/组件层不做判定，保证「无可用候选 =
// 零请求发出」与「已解析则不覆盖」两条纪律都能被单测钉住。

export type { PromptPolishModelSelection };

/**
 * 模型目录的最小结构面：与 ModelSelectionView（ModelConfigSelect 同源数据）结构兼容，
 * providers[].models[].config.enabled 为目录声明的模型级开关；进入目录本身即表示
 * provider 已发布可执行（凭据齐/账号当前），见 provider/src/resolver.ts 的 executable 判定。
 */
export interface PromptPolishCatalogModel {
  readonly modelId: string;
  readonly config?: { readonly enabled?: boolean } | null;
}

export interface PromptPolishCatalogProvider {
  readonly providerId: string;
  readonly models: readonly PromptPolishCatalogModel[];
}

export interface PromptPolishCatalog {
  readonly providers: readonly PromptPolishCatalogProvider[];
}

export const PROMPT_POLISH_QUERY_SOURCE = "prompt_polish";

/** 草稿润色的输出上限：单条 composer 草稿的润色结果，4096 足够且防跑飞。 */
export const PROMPT_POLISH_DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export function isSamePromptPolishModel(
  left: PromptPolishModelSelection | null | undefined,
  right: PromptPolishModelSelection | null | undefined,
): boolean {
  if (left == null || right == null) return left == null && right == null;
  return left.providerId === right.providerId && left.modelId === right.modelId;
}

/** 可用性判定按目录字段：provider/model 在目录内且模型未被声明禁用。 */
export function isPromptPolishModelAvailable(
  catalog: PromptPolishCatalog | null | undefined,
  selection: PromptPolishModelSelection | null | undefined,
): boolean {
  if (!catalog || !selection) return false;
  const provider = catalog.providers.find(
    (candidate) => candidate.providerId === selection.providerId,
  );
  if (!provider) return false;
  const model = provider.models.find((candidate) => candidate.modelId === selection.modelId);
  if (!model) return false;
  return model.config?.enabled !== false;
}

export type PromptPolishModelTier = "explicit" | "persisted" | "session";

export type PromptPolishModelResolution =
  | { status: "resolved"; selection: PromptPolishModelSelection; source: PromptPolishModelTier }
  | {
      status: "unavailable";
      /** no-candidates = 目录里没有任何可用模型；tier-miss = 各档缺失或不可用。 */
      reason: "no-candidates" | "tier-miss";
      /** 提供过但不可用的档位（日志/排障用，UI 文案不区分）。 */
      rejectedTiers: readonly PromptPolishModelTier[];
    };

function hasAnyAvailableModel(catalog: PromptPolishCatalog | null | undefined): boolean {
  if (!catalog) return false;
  return catalog.providers.some((provider) =>
    provider.models.some((model) => model.config?.enabled !== false),
  );
}

/**
 * 解析阶梯 explicit → persisted → session：逐档尝试，首个「提供且目录内可用」的档位
 * 立即返回——已解析则低档绝不覆盖（源项目两次踩坑的静默覆盖教训，回归测试钉住）。
 * 某档提供了但不可用时落入 rejectedTiers 并继续降档（回退而非静默改写：调用方在
 * 回执里可见 source）。全部落空 = unavailable，调用方必须给可读错误且零请求发出。
 */
export function resolvePromptPolishModel(input: {
  explicit?: PromptPolishModelSelection | null;
  persisted?: PromptPolishModelSelection | null;
  session?: PromptPolishModelSelection | null;
  catalog?: PromptPolishCatalog | null;
}): PromptPolishModelResolution {
  const catalog = input.catalog ?? null;
  const tiers: readonly [PromptPolishModelTier, PromptPolishModelSelection | null | undefined][] = [
    ["explicit", normalizePromptPolishModelSelection(input.explicit)],
    ["persisted", normalizePromptPolishModelSelection(input.persisted)],
    ["session", normalizePromptPolishModelSelection(input.session)],
  ];
  const rejectedTiers: PromptPolishModelTier[] = [];
  for (const [tier, selection] of tiers) {
    if (!selection) continue;
    if (isPromptPolishModelAvailable(catalog, selection)) {
      return { status: "resolved", selection, source: tier };
    }
    rejectedTiers.push(tier);
  }
  return {
    status: "unavailable",
    reason: hasAnyAvailableModel(catalog) ? "tier-miss" : "no-candidates",
    rejectedTiers,
  };
}

/**
 * 润色指令（自撰，语义要素见 spec §3）：保留原意/语言/关键约束与专名，只提升清晰度
 * 与结构；输出仅含润色后草稿正文，无解释前后缀。
 */
export const PROMPT_POLISH_SYSTEM_INSTRUCTION = [
  "You polish the user's draft prompt for an AI coding assistant.",
  "Rewrite the draft so it is clearer and better structured, while strictly preserving:",
  "- the original intent and every requirement, constraint and acceptance condition;",
  "- named entities, identifiers, file paths, code, commands and technical terms verbatim;",
  "- the language the draft is written in (never translate).",
  "Do not add new requirements, do not drop anything, do not answer the draft itself.",
  "Output only the polished draft text: no explanations, no prefaces, no wrapping quotes or code fences unless the draft already contains them.",
].join("\n");

export function buildPromptPolishMessages(
  draftText: string,
): V4WorkspaceModelMessage[] {
  return [
    { role: "system", content: PROMPT_POLISH_SYSTEM_INSTRUCTION },
    { role: "user", content: draftText },
  ];
}

export type PromptPolishRequestIssue = "empty-draft" | "no-model";

export type PromptPolishPreparedRequest =
  | {
      ok: true;
      selection: PromptPolishModelSelection;
      messages: V4WorkspaceModelMessage[];
      querySource: string;
      maxOutputTokens: number;
    }
  | { ok: false; issue: PromptPolishRequestIssue };

/**
 * 发请求前的全部预检收敛在这里（spec 产品规则 2/5）：空/纯空白草稿与无可用模型都
 * 返回可读 issue，调用方据此短路——保证「绝不发出注定失败的请求」。
 */
export function preparePromptPolishRequest(input: {
  draftText: string;
  resolution: PromptPolishModelResolution;
  maxOutputTokens?: number;
}): PromptPolishPreparedRequest {
  if (!input.draftText.trim()) {
    return { ok: false, issue: "empty-draft" };
  }
  if (input.resolution.status !== "resolved") {
    return { ok: false, issue: "no-model" };
  }
  return {
    ok: true,
    selection: input.resolution.selection,
    messages: buildPromptPolishMessages(input.draftText),
    querySource: PROMPT_POLISH_QUERY_SOURCE,
    maxOutputTokens: input.maxOutputTokens ?? PROMPT_POLISH_DEFAULT_MAX_OUTPUT_TOKENS,
  };
}
