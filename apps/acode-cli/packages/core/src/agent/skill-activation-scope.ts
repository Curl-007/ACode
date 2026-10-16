// ============================================================
// 技能激活期作用域（specs/skill-frontmatter-governance.md R4）
// ============================================================
// 「allowed-tools/disallowed-tools 在技能文件激活期间生效、失活即清」的登记模块与
// 查询接口。激活判据单一来源 = provider 可见历史（collectLoadedSkillNames，与
// loaded-skills.ts 的既有哲学一致：历史就是模型此刻记得的东西——compaction 把
// Skill 调用挤出去，规则随之出局；resume/rewind 重建历史，作用域随之重建）。
// store 是**缓存不是事实源**：唯一写路径是「历史变化后重算 refresh」。
//
// 权限面消费为接线项（core/src/permission/* 属并行批独占）：建议 deny 并入会话级
// deny 同位次、allow 并入会话级 allow 位次且仍受策略地板/硬阻断压制（技能自声明
// 授权永不穿透 policy floor）；匹配语义注记见 spec R4。

import type {
  SkillActivationScope,
  SkillMetadata,
  SkillToolRule,
  SessionId,
} from "@acode/contracts";
import type { RuntimeMessageEntry } from "./message-history.js";
import { collectLoadedSkillNames } from "./loaded-skills.js";

const EMPTY_SCOPE: SkillActivationScope = Object.freeze({
  allow: Object.freeze([]) as readonly SkillToolRule[],
  deny: Object.freeze([]) as readonly SkillToolRule[],
  skills: Object.freeze([]) as readonly string[],
});

/**
 * 已加载技能名 × 技能目录 → 激活期作用域（纯函数）。名字解析与 loadSkill 同语义
 * （name 或 qualifiedName 命中，首个生效）；无 governance 的技能贡献空集。
 * allow/deny 各自按 toolName+ruleContent 去重，保持首次出现序。
 */
export function buildSkillActivationScope(input: {
  loadedSkillNames: readonly string[];
  catalog: readonly SkillMetadata[];
}): SkillActivationScope {
  const allow: SkillToolRule[] = [];
  const deny: SkillToolRule[] = [];
  const skills: string[] = [];
  const seenRules = new Set<string>();
  const seenSkills = new Set<string>();
  for (const invokedName of input.loadedSkillNames) {
    const metadata = input.catalog.find(
      (skill) => skill.name === invokedName || skill.qualifiedName === invokedName,
    );
    if (!metadata?.governance) continue;
    if (!seenSkills.has(metadata.name)) {
      seenSkills.add(metadata.name);
      skills.push(metadata.name);
    }
    collectRules(metadata.governance.allowedTools, allow, seenRules);
    collectRules(metadata.governance.disallowedTools, deny, seenRules);
  }
  if (allow.length === 0 && deny.length === 0 && skills.length === 0) return EMPTY_SCOPE;
  return { allow, deny, skills };
}

function collectRules(
  rules: readonly SkillToolRule[] | undefined,
  target: SkillToolRule[],
  seen: Set<string>,
): void {
  for (const rule of rules ?? []) {
    const key = `${rule.toolName}\u0000${rule.ruleContent ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(rule);
  }
}

/** 便捷入口：直接从历史条目重算作用域（回合边界 / compaction 后的推荐刷新路径）。 */
export function collectSkillActivationScope(
  entries: readonly RuntimeMessageEntry[],
  catalog: readonly SkillMetadata[],
): SkillActivationScope {
  return buildSkillActivationScope({
    loadedSkillNames: collectLoadedSkillNames(entries),
    catalog,
  });
}

/**
 * per-session 作用域缓存（登记模块 + 查询接口）。权限面经 `snapshot` 只读查询；
 * 未登记会话返回共享空 scope。`clear` 供会话终结调用（失活即清的会话级形态）。
 */
export interface SkillActivationScopeStore {
  refresh(sessionId: SessionId | string, scope: SkillActivationScope): void;
  clear(sessionId: SessionId | string): void;
  clearAll(): void;
  snapshot(sessionId: SessionId | string): SkillActivationScope;
}

export function createSkillActivationScopeStore(): SkillActivationScopeStore {
  const scopes = new Map<string, SkillActivationScope>();
  return {
    refresh(sessionId, scope) {
      if (scope === EMPTY_SCOPE || (scope.allow.length === 0 && scope.deny.length === 0)) {
        // 空作用域不落条目：snapshot 天然返回共享空对象，Map 不随会话轮转膨胀。
        scopes.delete(String(sessionId));
        return;
      }
      scopes.set(String(sessionId), scope);
    },
    clear(sessionId) {
      scopes.delete(String(sessionId));
    },
    clearAll() {
      scopes.clear();
    },
    snapshot(sessionId) {
      return scopes.get(String(sessionId)) ?? EMPTY_SCOPE;
    },
  };
}

// ============================================================
// 进程级共享 store（spec R4「权限面消费」接线，波 2 接线波落地）
// ============================================================
// 唯一登记点：写路径收敛在 refreshSessionSkillActivationScope（重算语义，
// 触发点 = 回合边界 + Skill 调用成功后）；权限面经 snapshotSessionSkillActivationScope
// 只读查询；会话终结调 clearSessionSkillActivationScope。不开放第二写入路径。

const sharedSkillActivationScopeStore = createSkillActivationScopeStore();

/**
 * 唯一写入口：按「provider 可见历史 + 技能目录」重算。extraLoadedSkillNames 承载
 * 本批 Skill 调用刚成功、历史尚未入账的事实（tools.ts 的 batch_complete 触发点）——
 * 与历史名并集后走同一个 buildSkillActivationScope，重算语义不分叉。
 */
export function refreshSessionSkillActivationScope(input: {
  sessionId: SessionId | string;
  entries: readonly RuntimeMessageEntry[];
  catalog: readonly SkillMetadata[];
  extraLoadedSkillNames?: readonly string[];
}): void {
  const loadedSkillNames = collectLoadedSkillNames(input.entries);
  const names =
    input.extraLoadedSkillNames && input.extraLoadedSkillNames.length > 0
      ? [...loadedSkillNames, ...input.extraLoadedSkillNames]
      : loadedSkillNames;
  sharedSkillActivationScopeStore.refresh(
    input.sessionId,
    buildSkillActivationScope({ loadedSkillNames: names, catalog: input.catalog }),
  );
}

/** 权限面只读查询（permission-flow 每次裁决取快照）；未登记会话返回共享空 scope。 */
export function snapshotSessionSkillActivationScope(
  sessionId: SessionId | string,
): SkillActivationScope {
  return sharedSkillActivationScopeStore.snapshot(sessionId);
}

/** 会话终结的失活即清（会话级形态；进程亡故 = 缓存亡故，与台账哲学一致）。 */
export function clearSessionSkillActivationScope(sessionId: SessionId | string): void {
  sharedSkillActivationScopeStore.clear(sessionId);
}
