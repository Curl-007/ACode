// Config Port - Scoped configuration with change notification
//
// 例外偿还（contracts-onboarding-max-file-lines-config-index）：本文件原为 479 行
// 单体，已拆为 3 个叶子并降级为 barrel——公开导出面（符号名与模块路径）逐名不变，
// 消费方零改动。叶子：config-keys（键词表/作用域/来源）、runtime-config（RuntimeConfig
// 簇与默认值）、managed-policy（策略地板）；依赖单向（config-keys → runtime-config →
// managed-policy），无叶子回边。端口接口（ConfigPort/ConfigObserver）留在本 barrel。

import type { ConfigKey, ConfigScope, ConfigSource, ConfigValue } from "./config-keys.js";
import type { RuntimeConfig, RuntimeConfigPatch } from "./runtime-config.js";

// ============================================================
// Config Port Interface
// ============================================================

export interface Unsubscribe {
  (): void;
}

export interface ConfigObserver {
  subscribe<K extends ConfigKey>(
    key: K,
    handler: (value: ConfigValue<K>, prev: ConfigValue<K>) => void,
  ): Unsubscribe;
  subscribeAll(handler: (key: ConfigKey, value: unknown, prev: unknown) => void): Unsubscribe;
}

export interface ConfigPort {
  // Get configuration value
  get<K extends ConfigKey>(key: K): ConfigValue<K>;
  getAll(): RuntimeConfig;

  // Check if key exists
  has(key: ConfigKey): boolean;

  // Set configuration value (runtime only, not persisted by default)
  set<K extends ConfigKey>(key: K, value: ConfigValue<K>): void;

  // Get observer for scoped subscriptions
  observe(): ConfigObserver;

  // Get all sources for a key (for debugging/audit)
  getSources(key: ConfigKey): ConfigSource[];

  // Merge additional config (e.g., from file/env)
  merge(config: RuntimeConfigPatch, scope: ConfigScope): void;
}

// —— 叶子 re-export（顺序：无依赖 → 有依赖；`export *` 要求跨叶无重名）——
export * from "./managed-policy.js";
export * from "./runtime-config.js";
export * from "./config-keys.js";
