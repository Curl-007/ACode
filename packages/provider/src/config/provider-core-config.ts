// 2026-12-31 例外债务偿还：自 provider-config.ts 按职责拆出 —— Provider 主配置族
// （ProviderApiConfig 与 ProviderConfig Overlay，含可见性/Logo 类型与成员冻结、Access 合并 helper）。
// 逐字迁移，行为零改动；Access 族见 provider-access-config.ts，Template 族与 ProviderConfigMap 见同目录其余叶子。
import { ConfigOverlay, isBlockingConfigIssue, type ConfigValidationIssue } from "../config-overlay.js";
import type { z } from "zod";
import {
  completeProviderApiDataSchema,
  completeProviderConfigDataSchema,
  type providerVisibilityDataSchema,
  type providerLogoDataSchema,
  type providerApiDataSchema,
  type providerConfigDataSchema,
} from "./provider-data-schema.js";
import { validateConfigSchema } from "./schema-validation.js";
import { isPlaintextHttpBaseUrl } from "./provider-endpoint-security.js";
import type { ModelId } from "./ids.js";
import type {
  ApiKeyAccessConfig,
  ProviderAccessConfig,
  ZhipuAccountAccessConfig,
} from "./provider-access-config.js";

export type ProviderVisibility = z.infer<typeof providerVisibilityDataSchema>;

export type ProviderLogoRef = Readonly<z.infer<typeof providerLogoDataSchema>>;

export type ProviderApiConfigInput = Readonly<z.infer<typeof providerApiDataSchema>>;

export class ProviderApiConfig extends ConfigOverlay<ProviderApiConfig> {
  readonly type?: ProviderApiConfigInput["type"];
  readonly baseUrl?: ProviderApiConfigInput["baseUrl"];
  readonly headers?: ProviderApiConfigInput["headers"];

  constructor(input: ProviderApiConfigInput = {}) {
    super();
    this.type = input.type;
    this.baseUrl = input.baseUrl;
    this.headers = input.headers ? Object.freeze({ ...input.headers }) : input.headers;
    Object.freeze(this);
  }

  overlay(next: ProviderApiConfig): ProviderApiConfig {
    return new ProviderApiConfig({
      type: this.overlayValue(this.type, next.type),
      baseUrl: this.overlayValue(this.baseUrl, next.baseUrl),
      headers: this.overlayValue(this.headers, next.headers),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    // 旧检查只判断 type 非空，不可信 JS 值可绕过枚举；准入与保存共用 schema。
    const issues = [...validateConfigSchema(completeProviderApiDataSchema, this.toJSON(), path)];
    // 明文 http 是「知情不禁止」的告警而非阻断，severity 恒为 warning，与 zod error 可共存。
    // 非法 URL 时上面的 url 校验已报 error，isPlaintextHttpBaseUrl 对非法值返回 false，不会双报。
    if (isPlaintextHttpBaseUrl(this.baseUrl)) {
      issues.push({
        code: "plaintext-http-endpoint",
        path: [...path, "baseUrl"],
        severity: "warning",
        message: `配置 ${[...path, "baseUrl"].join(".")} 使用明文 http，API Key 与对话内容将暴露给链路中间节点，建议改用 https`,
      });
    }
    return issues;
  }

  toJSON(): ProviderApiConfigInput {
    return objectWithoutUndefined({
      type: this.type,
      baseUrl: this.baseUrl,
      headers: this.headers,
    });
  }
}

export type ProviderConfigInput = Omit<ProviderConfigObject, "access" | "api"> & {
  readonly access?: ProviderAccessConfig | null;
  readonly api?: ProviderApiConfig | null;
};

export type ProviderConfigObject = Readonly<z.infer<typeof providerConfigDataSchema>>;

export class ProviderConfig extends ConfigOverlay<ProviderConfig> {
  readonly group?: ProviderConfigObject["group"];
  readonly logo?: ProviderConfigObject["logo"];
  readonly access?: ProviderAccessConfig | null;
  readonly api?: ProviderApiConfig | null;
  readonly builtinModelIds?: ProviderConfigObject["builtinModelIds"];
  readonly personalModelIds?: ProviderConfigObject["personalModelIds"];
  readonly modelOrder?: ProviderConfigObject["modelOrder"];
  readonly visibility?: ProviderConfigObject["visibility"];

  constructor(input: ProviderConfigInput = {}) {
    super();
    this.group = input.group;
    this.logo = freezeProviderLogo(input.logo);
    this.access = input.access;
    this.api = input.api;
    this.builtinModelIds = freezeModelIds(input.builtinModelIds);
    this.personalModelIds = freezeModelIds(input.personalModelIds);
    this.modelOrder = freezeModelIds(input.modelOrder);
    this.visibility = input.visibility;
    Object.freeze(this);
  }

  overlay(next: ProviderConfig): ProviderConfig {
    return new ProviderConfig({
      group: this.overlayValue(this.group, next.group),
      logo: this.overlayValue(this.logo, next.logo),
      access: overlayProviderAccess(this.access, next.access),
      api: this.overlayConfig(this.api, next.api),
      builtinModelIds: this.overlayValue(this.builtinModelIds, next.builtinModelIds),
      personalModelIds: this.overlayValue(this.personalModelIds, next.personalModelIds),
      modelOrder: this.overlayValue(this.modelOrder, next.modelOrder),
      visibility: this.overlayValue(this.visibility, next.visibility),
    });
  }

  withBuiltinModelIds(builtinModelIds: readonly ModelId[]): ProviderConfig {
    return this.overlay(new ProviderConfig({ builtinModelIds }));
  }

  withPersonalModelIds(modelIds: readonly ModelId[]): ProviderConfig {
    return this.overlay(new ProviderConfig({ personalModelIds: modelIds }));
  }

  withModelOrder(modelOrder: readonly ModelId[]): ProviderConfig {
    return this.overlay(new ProviderConfig({ modelOrder }));
  }

  withoutGroup(): ProviderConfig {
    return new ProviderConfig({
      logo: this.logo,
      access: this.access,
      api: this.api,
      builtinModelIds: this.builtinModelIds,
      personalModelIds: this.personalModelIds,
      modelOrder: this.modelOrder,
      visibility: this.visibility,
    });
  }

  /** 普通 Provider 字段保存不拥有成员变更；成员只能由明确的领域操作更新。 */
  withModelMembershipFrom(source: ProviderConfig | undefined): ProviderConfig {
    return new ProviderConfig({
      group: this.group,
      logo: this.logo,
      access: this.access,
      api: this.api,
      builtinModelIds: source?.builtinModelIds,
      personalModelIds: source?.personalModelIds,
      modelOrder: source?.modelOrder,
      visibility: this.visibility,
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    // 不再用字段存在性代替值域验证，也不把展示/成员等可选字段变成执行必填项。
    const issues = [...validateConfigSchema(completeProviderConfigDataSchema, this.toJSON(), path)];
    // 明文 http 告警的唯一产生点是 api 子对象的 validateComplete（resolver 校验合并后的
    // effective config 走到这里，模板继承来的 http 值因此同样产出 warning）。外层 zod
    // 嵌套校验会产出同样的 api zod error，若整份并入子对象结果会把同一 error 报两遍，
    // 所以只把非阻断的诊断（warning）并入，error 仍以外层结果为准。
    if (this.api) {
      issues.push(
        ...this.api
          .validateComplete([...path, "api"])
          .filter((issue) => !isBlockingConfigIssue(issue)),
      );
    }
    return issues;
  }

  toJSON(): ProviderConfigObject {
    return objectWithoutUndefined({
      group: this.group,
      logo: this.logo,
      access: this.access?.toJSON() ?? this.access,
      api: this.api?.toJSON() ?? this.api,
      builtinModelIds: this.builtinModelIds,
      personalModelIds: this.personalModelIds,
      modelOrder: this.modelOrder,
      visibility: this.visibility,
    });
  }
}

function freezeProviderLogo(
  logo: ProviderLogoRef | null | undefined,
): ProviderLogoRef | null | undefined {
  return logo ? Object.freeze({ ...logo }) : logo;
}

function freezeModelIds(
  modelIds: readonly ModelId[] | null | undefined,
): readonly ModelId[] | null | undefined {
  if (!modelIds) return modelIds;
  return Object.freeze(
    modelIds.map((modelId) => {
      const normalized = modelId.trim();
      if (!normalized) throw new Error("Model ID 不能为空");
      return normalized;
    }),
  );
}

function overlayProviderAccess(
  current: ProviderAccessConfig | null | undefined,
  next: ProviderAccessConfig | null | undefined,
): ProviderAccessConfig | null | undefined {
  if (next === undefined) return current;
  if (next === null || current === undefined || current === null) return next;
  if (current.type !== next.type) return next;
  switch (current.type) {
    case "api-key":
    case "zhipu-coding-plan-api-key":
      return current.overlay(next as ApiKeyAccessConfig);
    case "zhipu-account":
      return current.overlay(next as ZhipuAccountAccessConfig);
  }
}

function objectWithoutUndefined<T extends object>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}
