// ============================================================
// 技能 paths 触发·会话激活集（specs/skill-frontmatter-governance.md R5 消费接线）
// ============================================================
// 路径触发式渐进披露的运行期登记面：声明了 `paths` 的技能在**本会话触碰匹配
// 文件之前**不进模型可见清单（sections/skills.ts 按本激活集过滤）；文件触碰类
// 工具成功后（executor call-runner 后置点）判定触发，命中即并入激活集，并经
// system-reminder 告知模型新技能可用。判定纯函数在 skill-path-triggers.ts
//（逃逸/上跳 fail-closed 不触发）；本文件只持会话键控激活集与事件面粘合。
//
// 生命周期与 R4 激活期作用域 store 同哲学：会话键控进程级 Map，会话终结经
// clearSkillPathActivations 清理（runtime beginShutdown），进程亡故 = 缓存亡故。

import type { SkillMetadata } from "@acode/contracts";
import { extractApplyPatchTargetPaths } from "../tool/apply-patch-format.js";
import { matchesSkillPathTrigger } from "./skill-path-triggers.js";

const activatedBySession = new Map<string, Set<string>>();

export interface SkillPathActivationInput {
  /** 会话身份；缺席（测试/无会话执行面）= 不激活（清单侧同因缺席不过滤，零回归）。 */
  sessionId: string | undefined;
  /** 本会话技能目录（runtime skillLoadOutcome 投影）；缺席 = 无从判定。 */
  catalog: readonly SkillMetadata[] | undefined;
  toolName: string;
  /** 本次工具调用的原始输入（提取 file_path/path/patch_text 目标）。 */
  toolInput: unknown;
  workingDirectory: string;
}

/**
 * 工具成功后置点：提取本次触碰路径 → 对「声明 pathTriggers 且未激活」的技能跑
 * 触发判定 → 命中登记并返回新激活技能（调用方据以生成 system-reminder）。
 */
export function activateSkillsForTouchedToolCall(input: SkillPathActivationInput): SkillMetadata[] {
  if (!input.sessionId) return [];
  const touchedPaths = touchedPathsFromToolInput(input.toolName, input.toolInput);
  if (touchedPaths.length === 0) return [];
  const catalog = input.catalog ?? [];
  if (catalog.length === 0) return [];

  const sessionKey = String(input.sessionId);
  let activated = activatedBySession.get(sessionKey);
  const newlyActivated: SkillMetadata[] = [];
  for (const skill of catalog) {
    const patterns = skill.governance?.pathTriggers;
    if (!patterns || patterns.length === 0) continue;
    if (activated?.has(skill.name)) continue;
    const hit = touchedPaths.some((touchedPath) =>
      matchesSkillPathTrigger({ patterns, touchedPath, workingDirectory: input.workingDirectory }),
    );
    if (!hit) continue;
    activated ??= new Set<string>();
    activated.add(skill.name);
    newlyActivated.push(skill);
  }
  if (activated && activated.size > 0) {
    activatedBySession.set(sessionKey, activated);
  }
  return newlyActivated;
}

/** 清单过滤面（sections/skills.ts）：本会话已路径激活的技能名集；未登记返回空集。 */
export function listPathActivatedSkills(sessionId: string | undefined): ReadonlySet<string> {
  if (!sessionId) return EMPTY_ACTIVATED;
  return activatedBySession.get(String(sessionId)) ?? EMPTY_ACTIVATED;
}

const EMPTY_ACTIVATED: ReadonlySet<string> = Object.freeze(new Set<string>());

/** 会话终结的失活即清（runtime beginShutdown 调用）。 */
export function clearSkillPathActivations(sessionId: string | undefined): void {
  if (!sessionId) return;
  activatedBySession.delete(String(sessionId));
}

/**
 * system-reminder 文案（自撰英文 = 模型面，prompt-language-policy R3）：告知触发
 * 事实与新技能可用性；不复述技能正文（清单段重建后模型自见 description）。
 */
export function buildSkillPathActivationReminder(skills: readonly SkillMetadata[]): string {
  const names = skills.map((skill) => skill.qualifiedName ?? skill.name);
  const listed = names.map((name) => `"${name}"`).join(", ");
  return (
    `<system-reminder>Path-triggered skill${names.length > 1 ? "s" : ""} now available: ${listed}. ` +
    "Files touched in this session matched the skill's declared paths, so it was added to the " +
    "available-skills list. Invoke it with the Skill tool only when the current task matches " +
    "its description.</system-reminder>"
  );
}

/** 工具输入 → 本次触碰路径（Read/Edit/Write 的 file_path/path；ApplyPatch 的目标集）。 */
function touchedPathsFromToolInput(toolName: string, toolInput: unknown): string[] {
  if (!toolInput || typeof toolInput !== "object") return [];
  const record = toolInput as Record<string, unknown>;
  const paths: string[] = [];
  for (const key of ["file_path", "path"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      paths.push(value.trim());
    }
  }
  if (toolName === "ApplyPatch" && typeof record.patch_text === "string") {
    paths.push(...extractApplyPatchTargetPaths(record.patch_text));
  }
  return paths;
}
