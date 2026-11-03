import { z } from "zod";
import { WSL_IDENTITY_MAX_LENGTH, isValidWslIdentity } from "./wslIdentityChars.js";

// 字符约束与长度上限已抽到 ./wslIdentityChars.js，与 distro 字段共用同一实现——两者必须
// 同步演进，此前 distro 无校验而 user 有，属不对称（见该文件头注释）。
//
// `WSL_USER_MAX_LENGTH` 沿用既有导出名：它是 @acode/shared 公开 barrel 的一部分
// （validation.ts 再导出），删名或改名属破坏性变更，而它与 distro 的上限本就是同一个数。
export const WSL_USER_MAX_LENGTH = WSL_IDENTITY_MAX_LENGTH;

export function isValidWslUser(value: string): boolean {
  return isValidWslIdentity(value);
}

export const wslUserSchema = z
  .string()
  .trim()
  .max(WSL_USER_MAX_LENGTH)
  .refine((value) => value.length === 0 || isValidWslUser(value), {
    message: "Invalid WSL user",
  });
