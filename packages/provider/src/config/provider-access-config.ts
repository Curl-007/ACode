// 2026-12-31 例外债务偿还：自 provider-config.ts 按职责拆出 —— Access 配置族
// （ApiKey/ZhipuAccount 两类 Access Overlay、联合类型与 isApiKeyAccess 谓词）。
// 逐字迁移，行为零改动；Provider 主配置、Template 族与 ProviderConfigMap 见同目录其余叶子。
import { ConfigOverlay, type ConfigValidationIssue } from "../config-overlay.js";
import type { z } from "zod";
import {
  completeApiKeyAccessDataSchema,
  completeZhipuAccountAccessDataSchema,
  type providerApiTypeDataSchema,
  type providerGroupDataSchema,
  type zhipuAccountModeDataSchema,
  type apiKeyAccessDataSchema,
  type zhipuAccountAccessDataSchema,
  type providerAccessDataSchema,
} from "./provider-data-schema.js";
import { validateConfigSchema } from "./schema-validation.js";

export type ProviderApiType = z.infer<typeof providerApiTypeDataSchema>;
export type ProviderGroup = z.infer<typeof providerGroupDataSchema>;
export type ZhipuAccountMode = z.infer<typeof zhipuAccountModeDataSchema>;

export type ApiKeyAccessConfigInput = Omit<ApiKeyAccessConfigObject, "type"> & {
  readonly type?: ApiKeyAccessConfigObject["type"];
};

export type ApiKeyAccessConfigObject = Readonly<z.infer<typeof apiKeyAccessDataSchema>>;

export class ApiKeyAccessConfig extends ConfigOverlay<ApiKeyAccessConfig> {
  readonly type: ApiKeyAccessConfigObject["type"];
  readonly apiKey?: ApiKeyAccessConfigInput["apiKey"];
  readonly apiKeyManagementUrl?: ApiKeyAccessConfigInput["apiKeyManagementUrl"];
  /**
   * 加密凭据库引用（安全加固 P1-5）。存在时表示真值已托管在 `credentials.json`，
   * 本对象的 `apiKey` 是 hydration 后的运行期内存值，**不得**回写磁盘。
   */
  readonly credentialRef?: ApiKeyAccessConfigInput["credentialRef"];

  constructor(input: ApiKeyAccessConfigInput = {}) {
    super();
    this.type = input.type ?? "api-key";
    this.apiKey = input.apiKey;
    this.apiKeyManagementUrl = input.apiKeyManagementUrl;
    this.credentialRef = input.credentialRef;
    Object.freeze(this);
  }

  overlay(next: ApiKeyAccessConfig): ApiKeyAccessConfig {
    // `apiKey` 与 `credentialRef` 在存储形态上互斥（P1-5）：真值要么在文件里（迁移前/回退态的
    // 明文），要么在凭据库里（ref）。overlayValue 的语义是「next 未定义就保留 base」，
    // 若直接对两个字段各自 overlay，会把「base 的旧 ref」与「next 的新明文 apiKey」同时留下，
    // 于是 toJSON() 只写 ref → **用户刚输入的新 Key 被静默丢弃**，界面看着像保存成功、
    // 实际仍在用旧 Key。这是真实的数据丢失，必须在 overlay 里排他处理。
    //
    // 规则：next 提供了哪一个，就以它为准并清掉另一个。
    // - next 带新明文 apiKey（用户在设置里改了 Key）→ 丢弃 base 的旧 ref，
    //   由写入路径把新 Key 存进凭据库并分配新 ref；
    // - next 带 ref（已 vault 化）→ 丢弃 base 的明文，避免明文回流磁盘；
    // - next 两者都没带 → 保留 base 现状（base 自身已是互斥的）。
    const nextProvidesApiKey = next.apiKey !== undefined;
    const nextProvidesRef = next.credentialRef !== undefined;
    return new ApiKeyAccessConfig({
      type: next.type,
      apiKey: nextProvidesApiKey
        ? next.apiKey
        : nextProvidesRef
          ? undefined
          : this.apiKey,
      apiKeyManagementUrl: this.overlayValue(this.apiKeyManagementUrl, next.apiKeyManagementUrl),
      credentialRef: nextProvidesRef
        ? next.credentialRef
        : nextProvidesApiKey
          ? undefined
          : this.credentialRef,
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(completeApiKeyAccessDataSchema, this.toJSON(), path);
  }

  /**
   * 磁盘形态：**有 credentialRef 就只写 ref，绝不写 apiKey 明文**。
   *
   * 这是 P1-5 的核心安全属性。运行期内存里 `apiKey` 可能已被 registry 的 hydration
   * 填上真值（下游约 39 处同步消费者依赖它），但落盘序列化必须丢掉它，否则等于
   * 白做迁移。仅在「未迁移 / 凭据库不可用的明文回退态」（有 apiKey、无 ref）时才写明文，
   * 以保证迁移完成前用户的 provider 不会当场失效。
   *
   * 注意 `validateComplete` 走的是本方法，因此 complete 校验看到的也是磁盘形态：
   * 有 ref 即满足「至少有一个」，不会因为运行期 apiKey 缺席而误报缺字段。
   */
  toJSON(): ApiKeyAccessConfigObject {
    const hasCredentialRef =
      typeof this.credentialRef === "string" && this.credentialRef.trim().length > 0;
    return {
      type: this.type,
      ...objectWithoutUndefined({
        // 有 ref 时不落明文；否则（迁移前/回退态）保留明文以免 provider 失效。
        apiKey: hasCredentialRef ? undefined : this.apiKey,
        apiKeyManagementUrl: this.apiKeyManagementUrl,
        credentialRef: this.credentialRef,
      }),
    };
  }
}

export type ZhipuAccountAccessConfigInput = Omit<ZhipuAccountAccessConfigObject, "type">;

export type ZhipuAccountAccessConfigObject = Readonly<z.infer<typeof zhipuAccountAccessDataSchema>>;

export class ZhipuAccountAccessConfig extends ConfigOverlay<ZhipuAccountAccessConfig> {
  readonly type = "zhipu-account" as const;
  readonly accountType?: ZhipuAccountAccessConfigInput["accountType"];
  readonly mode?: ZhipuAccountAccessConfigInput["mode"];
  readonly entitled?: ZhipuAccountAccessConfigInput["entitled"];

  constructor(input: ZhipuAccountAccessConfigInput = {}) {
    super();
    this.accountType = input.accountType;
    this.mode = input.mode;
    this.entitled = input.entitled;
    Object.freeze(this);
  }

  overlay(next: ZhipuAccountAccessConfig): ZhipuAccountAccessConfig {
    return new ZhipuAccountAccessConfig({
      accountType: this.overlayValue(this.accountType, next.accountType),
      mode: this.overlayValue(this.mode, next.mode),
      entitled: this.overlayValue(this.entitled, next.entitled),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(completeZhipuAccountAccessDataSchema, this.toJSON(), path);
  }

  toJSON(): ZhipuAccountAccessConfigObject {
    return {
      type: this.type,
      ...objectWithoutUndefined({
        accountType: this.accountType,
        mode: this.mode,
        entitled: this.entitled,
      }),
    };
  }
}

export type ProviderAccessConfig = ApiKeyAccessConfig | ZhipuAccountAccessConfig;

export type ProviderAccessConfigObject = Readonly<z.infer<typeof providerAccessDataSchema>>;

/** 手动 Key 的编辑/保存共用能力判断，不把套餐 Key 误写成普通 API Key。 */
export function isApiKeyAccess<T extends { readonly type: string }>(
  access: T | null | undefined,
): access is Extract<T, { readonly type: ApiKeyAccessConfigObject["type"] }> {
  return access?.type === "api-key" || access?.type === "zhipu-coding-plan-api-key";
}

function objectWithoutUndefined<T extends object>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}
