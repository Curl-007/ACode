import { z } from "zod";

/**
 * ACode agent 提供方的单一真源。
 *
 * 类型 ACodeProvider、运行时 schema acodeProviderSchema 都从这里派生,
 * 避免各处内联 z.enum([...]) 副本随新增/删除 provider 漂移。
 * 本模块只依赖 zod(叶子),可被 validation / acode-protocol 等无环引用。
 */
const ACODE_PROVIDERS = ["glm"] as const;

export const acodeProviderSchema = z.enum(ACODE_PROVIDERS);

export type ACodeProvider = (typeof ACODE_PROVIDERS)[number];
