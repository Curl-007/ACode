// answers 代答能力申报：client attach 时声明它能代答哪些交互请求（闭集）。
// spec: apps/acode-cli/specs/protocol-attachment-typed-errors.md R3（含证据出处）。
// 语义：只把请求路由给申报了该 kind 的 client；[] = 显式停止代答；重复 attach 按 clientId
// 幂等；给定列表（含 []）整体替换、缺席保持——唯一实现是 resolveAttachAnswers。单向声明
// 纪律：clientHello capabilities 是 .strict() 的，客户端只有见 hello 的
// `interactionAnswerRoster === true` 才能携带 answers 键，否则老 CLI 握不上手。
import { z } from "zod";
import { pendingInteractionKindSchema, type PendingInteractionKind } from "./snapshot.js";

/** 可代答的请求种类 = pendingInteraction kind 闭集（单一事实源在 snapshot.ts）。 */
export const attachAnswerKindSchema = pendingInteractionKindSchema;
export type AttachAnswerKind = PendingInteractionKind;

const ATTACH_ANSWER_KIND_COUNT = attachAnswerKindSchema.options.length;

/** 申报列表：kind 闭集内、不重复。`[]` 合法且有语义（显式停止代答），与字段缺席（保持先前）严格区分。 */
export const attachAnswersDeclarationSchema = z
  .array(attachAnswerKindSchema)
  .max(ATTACH_ANSWER_KIND_COUNT)
  .superRefine((kinds, context) => {
    if (new Set(kinds).size !== kinds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "answers declaration must not repeat a kind",
      });
    }
  });
export type AttachAnswersDeclaration = z.infer<typeof attachAnswersDeclarationSchema>;

/**
 * 三态合并的唯一实现：缺席 = 保持 previous（首次 attach 无申报 = 空集，永不被问）；
 * 给定（含 []）= 整体替换。重复 attach 以同一函数收敛，天然按 clientId 幂等。
 */
export function resolveAttachAnswers(
  previous: readonly AttachAnswerKind[] | undefined,
  incoming: readonly AttachAnswerKind[] | undefined,
): readonly AttachAnswerKind[] {
  if (incoming === undefined) return previous ?? [];
  return incoming;
}

/** 路由纪律：只有显式申报了该 kind 的 client 可被路由；判断 fail-closed。 */
export function clientAnswersKind(
  answers: readonly AttachAnswerKind[] | undefined,
  kind: AttachAnswerKind,
): boolean {
  return answers?.includes(kind) === true;
}

/** roster 回显（informational）：供 host 侧建账/展示；权威在各连接 clientHello 申报与收敛结果。 */
export const attachAnswersRosterEntrySchema = z
  .object({
    clientId: z.string().min(1),
    clientKind: z.enum(["desktop", "web", "mobileRemote", "mobileApp"]).optional(),
    answers: z.array(attachAnswerKindSchema),
  })
  .strict();
export type AttachAnswersRosterEntry = z.infer<typeof attachAnswersRosterEntrySchema>;

export const attachAnswersRosterSchema = z.array(attachAnswersRosterEntrySchema);
export type AttachAnswersRoster = z.infer<typeof attachAnswersRosterSchema>;
