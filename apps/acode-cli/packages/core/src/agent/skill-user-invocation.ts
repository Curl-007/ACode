// ============================================================
// 用户指名技能调用标记（specs/skill-frontmatter-governance.md R6 硬门接线）
// ============================================================
// disable-model-invocation 技能的「用户本回合敲的」信号桥：CLI 手动 /skill 提交
// 路径在 submitPrompt 之前落标记（**单一写者**），Skill handler 对受门技能按名
// 匹配一次性消费（**单一读者**）。工具层拿不到提交面事实，故以会话键控的进程级
// 标记桥接（provenance 台账同款生命周期哲学：进程亡故 = 标记亡故）。
//
// 边界如实登记：标记不带 turnId（提交时 turn 尚未铸造），「回合级」语义由
// 消费纪律逼近——只有名字匹配才消费；不匹配的受门技能调用被拒但**不吞标记**
//（用户指名的 X 仍可被本回合稍后的 Skill(X) 兑现）；新标记覆盖旧标记；会话
// 终结经 clearUserInvokedSkillMarker 清理。残余窗口：模型整回合未调用 Skill(X)
// 时标记留存至下一次同名调用——方向 fail-closed（未指名技能恒拒），留存的只是
// 「用户曾显式指名 X」这一事实的延迟兑现。

const markersBySession = new Map<string, string>();

/** CLI 手动 /skill 提交路径的唯一写入点（submitPrompt 之前调用）。 */
export function markUserInvokedSkillForTurn(
  sessionId: string | undefined,
  skillName: string,
): void {
  const name = skillName.trim();
  if (!sessionId || name.length === 0) return;
  markersBySession.set(String(sessionId), name);
}

/**
 * Skill handler 的唯一消费点：candidates = 本次调用的请求名 + 解析后的
 * name/qualifiedName。匹配即消费（一次性）；不匹配返回 false 且保留标记。
 */
export function consumeUserInvokedSkillMarker(
  sessionId: string | undefined,
  candidates: readonly string[],
): boolean {
  if (!sessionId) return false;
  const key = String(sessionId);
  const marked = markersBySession.get(key);
  if (marked === undefined) return false;
  const matched = candidates.some((candidate) => candidate.trim() === marked);
  if (matched) markersBySession.delete(key);
  return matched;
}

/** 会话终结清理（runtime beginShutdown）。 */
export function clearUserInvokedSkillMarker(sessionId: string | undefined): void {
  if (!sessionId) return;
  markersBySession.delete(String(sessionId));
}
