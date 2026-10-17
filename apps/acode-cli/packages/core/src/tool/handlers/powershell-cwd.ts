// ============================================================
// PowerShell 命令包裹与 cwd 捕获（specs/powershell-tool.md R3）
// ============================================================

import { readFile, unlink } from "node:fs/promises";

/**
 * 用户命令 + 状态捕获尾。语义对齐还原工程证据（prompts/0078 exit-code 注记）：
 * cmdlet 失败（$? false 且无 native exit code）→ exit 1；native 非零 → 透传原
 * exit code；成功 → 把 (Get-Location).Path 写入临时文件供 handler 读回。
 * 用户命令自身 `exit N`/解析错误会跳过尾部——无捕获、退出码即事实。
 */
export function createWrappedPowerShellCommand(command: string, cwdFilePath: string): string {
  // PS 单引号字符串里 ' 转义为 ''；临时路径来自 tmpdir()，防御性转义即可。
  const literal = cwdFilePath.replaceAll("'", "''");
  return [
    command,
    "$__acode_ok = $?; $__acode_code = $LASTEXITCODE",
    `if ($__acode_ok) { [IO.File]::WriteAllText('${literal}', (Get-Location).Path) } elseif ($__acode_code -is [int] -and $__acode_code -ne 0) { exit $__acode_code } else { exit 1 }`,
  ].join("\n");
}

/** 读回捕获的 cwd；读完即删（finally best-effort），失败/缺席返回 undefined。 */
export async function readCapturedPowerShellCwd(
  cwdFilePath: string,
): Promise<string | undefined> {
  try {
    const raw = await readFile(cwdFilePath, "utf8");
    // WriteAllText 在 .NET Framework/.NET 均写 UTF-8 无 BOM；BOM 防御性剥除。
    const value = raw.replace(/^\uFEFF/u, "").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  } finally {
    try {
      await unlink(cwdFilePath);
    } catch {
      // 捕获文件清理失败不能影响工具结果。
    }
  }
}
