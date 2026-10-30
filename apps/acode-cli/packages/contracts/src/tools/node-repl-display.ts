// U11：`node_repl_images` display payload 的契约镜像（specs/tool-media-attachment-ref.md R10.5）。
//
// 从 `tool-result-metadata.ts` 抽出的叶子，理由与该文件里既有的 `read-search-display.ts` /
// `workflow-observation-display.ts` 相同：display 族 schema 各自成叶，避免
// `tool-result-metadata.ts`（strict union 的汇聚点）随每个新 display variant 单调增长。
// 导出面经 `tools/index.ts` 的 `export *` 保持不变，`@acode/contracts` 的消费方无需改动。
import { z } from "zod";
// 只 import **常量与纯函数**，不 import zod v4 的 schema 对象——本包是 zod v3，
// 复用 v4 schema 对象会让 `.strict()` / union 行为跨版本漂移（镜像只能手工同形，
// 由 tests/tool-media-ref-contract-parity.test.mjs 机械化守护）。
import {
  PROTOCOL_V4_LIMITS,
  TOOL_MEDIA_MAX_DIMENSION,
  TOOL_MEDIA_MAX_IMAGES,
  TOOL_MEDIA_MAX_INLINE_BASE64_CHARS,
  inspectToolMediaRef,
} from "@acode/shared/acode-protocol-v4";

/**
 * node_repl cell 的目标应用身份（Computer Use）。`appKey` 是 producer 的形态：
 * `darwin:<bundleId>` / `windows-aumid:<aumid>` / `windows-exe:<path>` / `linux-exe:<path>`；
 * UI 按前缀派生 `ApplicationIconLocator` 再交给平台服务解析，协议不承载图标字节。
 */
export const nodeReplCuaAppDisplaySchema = z
  .object({
    appKey: z.string().trim().min(1).max(2_048),
    displayName: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

/**
 * U11：`node_repl_images` display 的单张图片——**inline base64（legacy）或 ref 形态**二者之一。
 *
 * 这是 `packages/shared/src/acode-protocol-v4/tool-media-ref.ts` 的 `toolMediaImageSchema` 的
 * **strict 镜像**。两侧必须逐字同界：contracts 用 zod v3、shared 用 zod v4，**不能**跨包复用同一个
 * schema 对象，只能镜像；漂移由 `tests/tool-media-ref-contract-parity.test.mjs` 机械化挡住
 * （同一批正/负样本在两个 schema 上必须给出相同的接受/拒绝结论）。
 *
 * 用 union 而非「一个对象上两个可选字段」：让 `.strict()` 分别作用于每个分支，一个既带 `base64`
 * 又带 `ref`、或带未知字段的对象在两个分支都失败 → 整块被拒。**additive**：inline 分支逐字不动，
 * 因此已持久化的旧 row 照常解析（改名/改界会让旧 row 在 strict union 里整段被剥）。
 *
 * ref 形态的上限常量与形态判据（`inspectToolMediaRef`）都取自 shared：形态检查是纯函数，
 * zod v3 的 `superRefine` 可直接复用，于是「形态非法的 ref 在协议校验层就被拒」两侧同判据。
 */
export const nodeReplImageToolMediaSchema = z.union([
  z
    .object({
      base64: z.string().min(1).max(TOOL_MEDIA_MAX_INLINE_BASE64_CHARS),
      mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/iu),
    })
    .strict(),
  z
    .object({
      ref: z.string().superRefine((value, context) => {
        const rejection = inspectToolMediaRef(value);
        if (rejection !== null) {
          context.addIssue({
            code: "custom",
            message: `tool media ref rejected: ${rejection}`,
          });
        }
      }),
      mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/iu),
      bytes: z.number().int().positive().max(PROTOCOL_V4_LIMITS.attachmentMaxBytes),
      width: z.number().int().positive().max(TOOL_MEDIA_MAX_DIMENSION).optional(),
      height: z.number().int().positive().max(TOOL_MEDIA_MAX_DIMENSION).optional(),
      sha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/u)
        .optional(),
    })
    .strict(),
]);

export const nodeReplImageToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("node_repl_images"),
    // images 可选而不是 min(1)：CUA 的纯动作 cell（点击、输入）没有截图，但仍要投影 app 身份。
    // kind 名保留为 node_repl_images —— 改名会让已持久化的 row 在 strict union 里整段被剥掉。
    images: z.array(nodeReplImageToolMediaSchema).min(1).max(TOOL_MEDIA_MAX_IMAGES).optional(),
    app: nodeReplCuaAppDisplaySchema.optional(),
    truncated: z.boolean().optional(),
    source: z.literal("browser_turn_end").optional(),
  })
  .strict();

export type NodeReplImageToolResultDisplayPayload = z.infer<
  typeof nodeReplImageToolResultDisplayPayloadSchema
>;
export type NodeReplCuaAppDisplay = z.infer<typeof nodeReplCuaAppDisplaySchema>;
