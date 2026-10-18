// ============================================================
// StablePrefix - ContextBuildResult 字节稳定前缀缓存（WI-10 R1）
// ============================================================
//
// Ported from oh-my-pi (MIT) — packages/agent/src/append-only-context.ts,
// Copyright (c) 2025 Mario Zechner & Stencil Labs
//
// 移植说明：omp 的 StablePrefix 冻结「system prompt + 工具规格」快照，靠
// per-tool wire-identity 快路径判定输入未变。ACode 的工具规格走 model request
// 的 tools 字段、不进 system prompt（builder.ts 头注），冻结对象因此收敛为
// ContextBuildResult 整体（sections + systemMessages + metaUserAttachments），
// 命中判定用**序列化字节相等**而不是 hash 相等——32-bit hash 碰撞的后果是发错
// 系统提示词，不可接受；hash 只作诊断指纹。Bun API 降解：本模块零 IO、零 Bun
// 依赖，纯 TS。
//
// 所有权与事件顺序见 specs/stable-prefix-pause-gate.md R1：
// - 缓存键 = ContextBuilderConfig.sessionId（rebuildContextPrefix 每 turn 新建
//   builder 实例，缓存必须跨实例存活才能冻结字节）；sessionId 缺席退化为
//   builder 实例私有缓存，绝不跨会话共享。
// - store 只增 version、不改写旧 result 对象（仍持旧 result 的调用方字节不变）。
// - 注册表 LRU 上限 32 键：长寿进程（desktop host 多会话）不无界增长。

import type { ContextBuildResult } from "./types.js";

/** 模块级注册表的 LRU 上限（每键一个冻结 ContextBuildResult，~几十 KB）。 */
const STABLE_PREFIX_CACHE_LIMIT = 32;

/**
 * ContextBuildResult 的显式序列化投影。字段序固定：不同 section builder 的
 * 对象字面量键序不保证一致，裸 JSON.stringify(result) 会产生假 miss。
 * preview 是 content 的派生量（前 100 字符），不参与指纹。
 */
export function serializeContextBuildResult(result: ContextBuildResult): string {
  return JSON.stringify({
    s: result.sections.map((section) => [
      section.name,
      section.source,
      section.injectionTarget,
      section.cacheHint,
      section.chars,
      section.tokens,
      section.content,
    ]),
    m: result.systemMessages.map((message) => [
      message.role,
      message.content,
      message.cacheControl ?? null,
    ]),
    a: result.metaUserAttachments.map((attachment) => [attachment.source, attachment.content]),
    tc: result.totalChars,
    tt: result.totalTokens,
  });
}

/**
 * 诊断指纹（omp computeFingerprint 同款 djb2→base36）。**只作观测**，
 * 命中判定必须走 serializeContextBuildResult 的字节相等比较。
 */
export function stablePrefixFingerprint(serialized: string): string {
  let hash = 0;
  for (let i = 0; i < serialized.length; i++) {
    hash = ((hash << 5) - hash + serialized.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

interface StablePrefixEntry {
  readonly serialized: string;
  readonly fingerprint: string;
  readonly result: ContextBuildResult;
}

/**
 * 冻结的 ContextBuildResult 快照。首个 store 拍照；此后凡序列化字节相等的
 * build 都拿回**同一个对象**（同引用 ⇒ 同字节 ⇒ provider prompt-cache 断点
 * 稳定）；字节变化（模型行/日期/技能清单等真实输入变化）则重拍并 version++。
 */
export class StablePrefixCache {
  #entry: StablePrefixEntry | null = null;
  #version = 0;

  /** 快照重拍次数（含首拍）；invalidate 不清零，供漂移观测。 */
  get version(): number {
    return this.#version;
  }

  /** 当前冻结快照的诊断指纹；未建时 "<unbuilt>"。 */
  get fingerprint(): string {
    return this.#entry?.fingerprint ?? "<unbuilt>";
  }

  get built(): boolean {
    return this.#entry !== null;
  }

  /** 命中判定：序列化字节相等 → 返回冻结 result（同引用）；否则 null。 */
  reuse(serialized: string): ContextBuildResult | null {
    if (this.#entry !== null && this.#entry.serialized === serialized) {
      return this.#entry.result;
    }
    return null;
  }

  /** 存入新快照。返回 true = 前缀确实变化（缓存 miss 已发生，version 已 bump）。 */
  store(serialized: string, result: ContextBuildResult): boolean {
    this.#entry = {
      serialized,
      fingerprint: stablePrefixFingerprint(serialized),
      result,
    };
    this.#version++;
    return true;
  }

  /**
   * 显式失效（omp invalidate 语义）：丢弃冻结快照，下一次 build 必然重拍。
   * 面向「输入没变但必须重拍」的外部事件（MCP 重连、工具/技能集变更等若已
   * 反映在段输出上则指纹自然变化、无需显式调用）与测试。version 保留。
   */
  invalidate(): void {
    this.#entry = null;
  }
}

// -----------------------------------------------
// 模块级注册表（按 sessionId 分键，LRU）
// -----------------------------------------------

const cacheRegistry = new Map<string, StablePrefixCache>();

/**
 * 取（或建）某会话键的冻结缓存。每次访问把键挪到 Map 尾部（插入序 = LRU 序），
 * 超上限时逐出最久未用键——被逐出会话的下次 build 只是重拍一次，无正确性影响。
 */
export function getStablePrefixCache(key: string): StablePrefixCache {
  const existing = cacheRegistry.get(key);
  if (existing) {
    cacheRegistry.delete(key);
    cacheRegistry.set(key, existing);
    return existing;
  }
  const created = new StablePrefixCache();
  cacheRegistry.set(key, created);
  while (cacheRegistry.size > STABLE_PREFIX_CACHE_LIMIT) {
    const oldest = cacheRegistry.keys().next();
    if (oldest.done === true) break;
    cacheRegistry.delete(oldest.value);
  }
  return created;
}

/** 显式失效某会话键的冻结快照（键不存在返回 false）。 */
export function invalidateStablePrefixCache(key: string): boolean {
  const cache = cacheRegistry.get(key);
  if (!cache) return false;
  cache.invalidate();
  return true;
}

/** 清空全部注册表条目（测试隔离 / 进程级重置用）。 */
export function clearStablePrefixCaches(): void {
  cacheRegistry.clear();
}
