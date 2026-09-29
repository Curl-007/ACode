/**
 * 诊断严重度（spec: packages/provider/specs/config-validation-severity.md）。
 * 词汇对齐 CLI 域 ConfigDiagnostic.severity（adapters/src/config/schema.ts）的既有惯例；
 * 两个类型属不同配置域，不合并，只对齐词汇。
 */
export type ConfigValidationSeverity = "error" | "warning";

export interface ConfigValidationIssue {
  readonly code:
    | "required-field-missing"
    | "duplicate-key"
    | "duplicate-model"
    | "invalid-option-spec"
    | "invalid-config"
    | "invalid-reasoning-mapping"
    | "invalid-pattern"
    | "invalid-url"
    | "missing-template"
    /** 明文 http:// Base URL：知情不禁止的告警（判定事实源 isPlaintextHttpBaseUrl），severity 恒为 warning。 */
    | "plaintext-http-endpoint";
  readonly path: readonly string[];
  readonly message: string;
  /**
   * 缺省视为 error：全部既有产生点都是阻断语义，可选字段保证契约变更是 additive 的。
   * warning 只随 ProviderConfigResolution.issues / ProviderSettingsView 流转，
   * 不影响 resolver 的任何准入门控（见 spec R3）。
   */
  readonly severity?: ConfigValidationSeverity;
}

/** 门控唯一谓词（spec R1）：禁止调用点手写 severity 过滤，避免各处分叉。 */
export function isBlockingConfigIssue(issue: ConfigValidationIssue): boolean {
  return (issue.severity ?? "error") === "error";
}

/** 门控唯一谓词（spec R1）：issues 中存在阻断级问题才影响准入/可执行性。 */
export function hasBlockingConfigIssues(
  issues: readonly ConfigValidationIssue[],
): boolean {
  return issues.some(isBlockingConfigIssue);
}

/**
 * 稀疏配置层和覆盖完成后的配置使用同一类型。
 *
 * 子类显式列出字段；本基类只统一“缺省继承、Config 递归覆盖、其他值整体替换”的语义。
 */
export abstract class ConfigOverlay<TSelf extends ConfigOverlay<TSelf>> {
  abstract overlay(next: TSelf): TSelf;

  abstract validateComplete(path?: readonly string[]): readonly ConfigValidationIssue[];

  protected overlayValue<T>(base: T | undefined, next: T | undefined): T | undefined {
    return next === undefined ? base : next;
  }

  protected overlayConfig<T extends ConfigOverlay<T>>(
    base: T | null | undefined,
    next: T | null | undefined,
  ): T | null | undefined {
    if (next === undefined) return base;
    if (next === null || base === null || base === undefined) return next;
    return base.overlay(next);
  }
}

export function requiredFieldIssue(path: readonly string[], field: string): ConfigValidationIssue {
  return {
    code: "required-field-missing",
    path: [...path, field],
    message: `缺少必填配置 ${[...path, field].join(".")}`,
  };
}
