/**
 * Account Access schema/类型的唯一事实源（无内部依赖的叶子文件）。
 *
 * 为什么独立成文件：acode-protocol/index.ts 从 usage-stats.ts 导入值
 *（APP_USAGE_RANGES、appUsageSnapshotSchema），而 usage-stats.ts 需要
 * ACodeAccountAccess / ACodeProviderAccountAccess 两个类型。定义若留在
 * acode-protocol/index.ts 会形成文件级循环依赖（架构检查 forbidCycles 命中），
 * 因此把定义搬到本叶子文件：两侧都从这里导入，acode-protocol/index.ts 保持
 * re-export，公开 API 名不变。
 */
import { z } from "zod";

// 与 acode-protocol/index.ts 内部私有的 nonEmptyString 同形（z.string().trim().min(1)），
// 保证搬移后的 schema 结构与 z.infer 类型完全一致。
const nonEmptyString = z.string().trim().min(1);

export const acodeAccountAccessSchema = z.discriminatedUnion("planKind", [
  z
    .object({
      type: z.literal("zhipu-account"),
      family: z.enum(["zai", "bigmodel"]),
      planKind: z.literal("start-plan"),
    })
    .strict(),
  z
    .object({
      type: z.literal("zhipu-account"),
      family: z.enum(["zai", "bigmodel"]),
      planKind: z.literal("individual-coding-plan"),
    })
    .strict(),
  z
    .object({
      type: z.literal("zhipu-account"),
      family: z.enum(["zai", "bigmodel"]),
      planKind: z.literal("team-coding-plan"),
      productId: nonEmptyString,
      organizationId: nonEmptyString,
      projectId: nonEmptyString,
    })
    .strict(),
]);
export type ACodeAccountAccess = z.infer<typeof acodeAccountAccessSchema>;

/** Active Model 固定的账号访问类别；当前商品和 Team scope 由账号服务在请求期解析。 */
export const acodeProviderAccountAccessSchema = z
  .object({
    type: z.literal("zhipu-account"),
    accountType: z.enum(["zai", "bigmodel"]),
    mode: z.enum(["start-plan", "individual-coding-plan", "team-coding-plan", "off-peak"]),
    entitled: z.boolean(),
  })
  .strict();
export type ACodeProviderAccountAccess = z.infer<typeof acodeProviderAccountAccessSchema>;
