// Ported from oh-my-pi (MIT) — packages/ai/src/utils/schema/adapt.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// strict 适配组合器（provider 调用点的薄封装）
// ============================================================
// spec: apps/acode-cli/specs/tool-schema-normalize.md R3。
// 解耦：omp 的 $flag("PI_NO_STRICT")（pi-utils/Bun 生态）降解为 process.env
// 惰性读取；语义保留——调试 provider 误报 strict 支持、或对比 strict/非 strict
// 输出时的全局旁路。

import { upgradeJsonSchemaTo202012 } from "./draft.js";
import { tryEnforceStrictSchema } from "./strict-enforce.js";

/**
 * 全局旁路 OpenAI strict 强制的环境变量（omp PI_NO_STRICT 对应物）。
 * 惰性读取：进程运行中置位也生效，且模块加载期零环境依赖。
 */
export function isStrictToolSchemaBypassed(): boolean {
  const value = process.env["ACODE_NO_STRICT_TOOL_SCHEMA"];
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

/**
 * OpenAI 风格 strict schema 强制的统一 helper。
 * 调用方自己算 strict 布尔（各家逻辑不同），然后交给这里统一处理
 * tryEnforceStrictSchema 的舞步：
 * - draft-07 形状输入先升级到 2020-12。
 * - strict 为 false：升级后的 schema 原样通过。
 * - strict 为 true：尝试强制 strict；schema 不可表达时回退非 strict
 *   （返回值里的 strict 字段是**实际生效**的 strict，调用方只在其为 true
 *   时才在 wire 上发 strict:true）。
 */
export function adaptSchemaForStrict(
  schema: Record<string, unknown>,
  strict: boolean,
): { schema: Record<string, unknown>; strict: boolean } {
  const upgraded = upgradeJsonSchemaTo202012(schema) as Record<string, unknown>;
  if (!strict || isStrictToolSchemaBypassed()) {
    return { schema: upgraded, strict: false };
  }

  return tryEnforceStrictSchema(upgraded);
}
