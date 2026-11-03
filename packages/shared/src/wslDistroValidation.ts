import { z } from "zod";
import { WSL_IDENTITY_MAX_LENGTH, isValidWslIdentity } from "./wslIdentityChars.js";

// WSL distro 名校验。与 user 字段同一强度、同一约束来源（./wslIdentityChars.js）。
//
// 为什么需要它：distro 曾是裸 `z.string().optional()`，而 user 一直有专用 schema。两者不对称
// 的后果在 wsl-backend.ts 的解析路径上被放大——`safeListDistros` 枚举失败时**吞错返回 []**，
// 此时 `launchDistroName` 回落到用户原始字符串，可不经「与实际枚举结果比对」这一步直达
// `-d` argv 元素。有 `--` 终止符与 argv 隔离，不构成命令注入，但一个未经任何字符约束的值
// 会进入 identity、日志与 distro 比对逻辑。
//
// 合法 distro 名在实际部署里是 `Ubuntu-22.04`、`docker-desktop`、`Debian` 这类，本约束
// （字母数字与 `_ . -`，无控制字符与分隔符）不会拒绝任何真实名称。
export function isValidWslDistro(value: string): boolean {
  return isValidWslIdentity(value);
}

export const wslDistroSchema = z
  .string()
  .trim()
  .max(WSL_IDENTITY_MAX_LENGTH)
  // 与 wslUserSchema 同一形态：空串代表「未指定」，交由后端枚举/默认 distro 决定，
  // 不在此处报错；非空则必须是合法身份字段。
  .refine((value) => value.length === 0 || isValidWslDistro(value), {
    message: "Invalid WSL distro",
  });
