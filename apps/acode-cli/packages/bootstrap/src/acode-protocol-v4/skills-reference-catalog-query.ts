// Composer Skill 只读 catalog 的 v4 handler（apps/acode-cli/specs/m2-6-workflows-skills-mcp.md）。
//
// 实体自 legacy `acode-protocol/skill-reference-catalog.ts` 逐字迁入（M2-6：实体放 v4 目录，
// server.ts 只留一行转发，不在待删目录留实体债）。唯一改动：params/result 改 v4 schema
// （形状与 legacy 逐字 parity）。
// 与 Skills Settings 管理接口分离：这里的 sessionId 决定 authority，不提供启停/删除能力。
import {
  v4SkillsReferenceCatalogParamsSchema,
  type V4SkillReferenceCatalogEntry,
  type V4SkillsReferenceCatalogResult,
} from "@acode/shared/acode-protocol-v4";
import type { SkillLoadOutcome, SkillMetadata } from "@acode/contracts";
import { listACodeSkills } from "../skills.js";
import {
  parseParams,
  requireSession,
  type ACodeProtocolAgentServerContext,
} from "../acode-protocol/server-types.js";

export async function getSkillReferenceCatalog(
  context: ACodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<V4SkillsReferenceCatalogResult> {
  const params = parseParams(v4SkillsReferenceCatalogParamsSchema, rawParams);
  if (params.sessionId) {
    const record = requireSession(context, params.sessionId);
    const outcome = await record.app.getSkillCatalog();
    return toResult("session", outcome);
  }

  // 旧 UI cache 只在 workspace 首次挂载时扫描，用户从文件系统手动新增
  // Skill 后，新建对话仍停在旧快照。草稿请求在 Agent 侧复用 CLI 正式发现配置，
  // 每次新打开引用面板都读取当前 workspace catalog。
  const outcome = await listACodeSkills({
    env: context.deps.env,
    logger: context.logger,
    workingDirectory: params.workspace.workspacePath,
  });
  return toResult("workspace", outcome);
}

function toResult(
  authority: V4SkillsReferenceCatalogResult["authority"],
  outcome: SkillLoadOutcome,
): V4SkillsReferenceCatalogResult {
  return {
    authority,
    // 内置技能包（bundled-skills.ts）不进引用面板：它由内置命令（`/workflow`）加载，不是用户
    // 管理或引用的对象；协议的 scope 是封闭枚举，旧客户端严格校验，这里不为它扩枚举。
    skills: outcome.skills
      .filter((skill) => skill.source !== "bundled")
      .map(toReferenceCatalogEntry),
  };
}

function toReferenceCatalogEntry(skill: SkillMetadata): V4SkillReferenceCatalogEntry {
  const scope =
    skill.source === "plugin" ? "plugin" : skill.scope === "project" ? "workspace" : "user";
  return {
    // `glm:` 是现有 UI provider 过滤契约；路径使同名不同来源仍有稳定行身份。
    id: `glm:${scope}:${skill.path}`,
    name: skill.name,
    description: skill.description,
    path: skill.path,
    scope,
    enabled: true,
    ...(skill.pluginName ? { pluginName: skill.pluginName } : {}),
  };
}
