import type { ACodeSessionFile, ACodeTaskMeta } from "@acode/shared";
import { acodeSessionFileSchema, acodeTaskMetaSchema, acodeTaskModeSchema } from "@acode/shared";

export type LegacyTaskSessionFile = Omit<ACodeSessionFile, "meta"> & {
  meta: Omit<ACodeTaskMeta, "mode"> & { mode?: ACodeTaskMeta["mode"] };
};

const legacyTaskSessionFileSchema = acodeSessionFileSchema.extend({
  // Claude 原生迁移会按清洗路径删除 meta.mode。
  // legacy snapshot 读取/写入仍要校验其它必需字段，但不能再强制把被过滤字段补回文件。
  meta: acodeTaskMetaSchema.extend({
    mode: acodeTaskModeSchema.optional(),
  }),
});

export function parseLegacyTaskSessionFile(input: unknown): LegacyTaskSessionFile {
  return legacyTaskSessionFileSchema.parse(input);
}

export function safeParseLegacyTaskSessionFile(input: unknown) {
  return legacyTaskSessionFileSchema.safeParse(input);
}
