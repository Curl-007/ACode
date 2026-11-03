// WSL 连接身份字段（distro / user）的共享字符约束。
//
// 抽成独立叶子而不是各写一份：两个字段的合法字符集完全相同，且必须同步演进——放宽其中一个
// 而忘了另一个，就会出现「user 拦得住、distro 拦不住」的不对称（这正是 Mimosa
// scan-2026-11-03 复核登记的待跟进第 6 条：distro 曾是裸 `z.string().optional()`）。
// 见 docs/security/mimosa-findings-triage-2026-11.md §6.2.1。
//
// 校验的目的不是防命令注入：两个值都作为**独立 argv 元素**交给 wsl.exe
// （`-d <distro> -u <user> -- bash -lc …`，见 packages/server/src/remote/wslBackendSupport.ts
// 的 buildWslArgs，含 `--` 终止符），不经 shell。真正要挡的是两件事：
// ① 身份与日志洁净——远程历史重连直接使用 settings 里的值，绕过 UI 后仍不得把控制字符或
//    路径分隔符带进 identity/日志；
// ② 与执行侧的解析假设一致——distro 名不含分隔符，故 wsl-backend 读回实际身份后的比对与
//    `-d` 传参都不必再处理跨段值。

/** 两个身份字段共用的长度上限（各平台对 argv 长度与路径段的实际上限都远大于此）。 */
export const WSL_IDENTITY_MAX_LENGTH = 64;

/** 拒绝 C0 控制字符与 DEL：它们会破坏日志行、终端渲染与 identity 比对。 */
export function containsControlCharacter(value: string): boolean {
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) {
      return true;
    }
  }
  return false;
}

/**
 * 身份字段的共同约束：非空、长度受限、无控制字符、不含 `:` `/` `\`。
 *
 * `:` 是 WSL/Unix 身份语境里的分隔符，`/` 与 `\` 是两种平台的路径分隔符——三者都不该出现在
 * 一个「名字」里，出现即说明值不是名字而是被拼进来的路径或复合串。
 */
export function isValidWslIdentity(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= WSL_IDENTITY_MAX_LENGTH &&
    !containsControlCharacter(trimmed) &&
    !trimmed.includes(":") &&
    !trimmed.includes("/") &&
    !trimmed.includes("\\")
  );
}
