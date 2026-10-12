import { z } from "zod";

// userInput 行上「本条输入已被 CLI 展开为斜杠命令」的展示元数据
// （spec: docs/specs/custom-command-invocation-echo.md）。只有展开成功才在场。
// scope/source 用宽松字符串：CLI 新增来源时旧客户端只是显示原值，不能因闭集校验丢掉整行。
export const customCommandInvocationMetaSchema = z.object({
  name: z.string().min(1),
  scope: z.string().min(1),
  source: z.string().min(1).optional(),
  description: z.string().optional(),
});
export type CustomCommandInvocationMeta = z.infer<typeof customCommandInvocationMetaSchema>;
