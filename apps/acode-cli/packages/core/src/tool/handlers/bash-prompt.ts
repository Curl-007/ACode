export function createBashProviderDescription(input: {
  defaultTimeoutMs: number;
  embeddedSearchEnabled?: boolean;
  maxTimeoutMs: number;
  platform?: NodeJS.Platform;
}): string {
  const avoidCommands = input.embeddedSearchEnabled
    ? "`cat`, `head`, `tail`, `sed`, `awk`, or `echo`"
    : "`find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo`";
  // W2-PS（specs/powershell-tool.md R6）：Windows 上显式锚定 Bash=Git Bash（POSIX sh），
  // 并给出与 PowerShell 工具的分工——Windows 原生面（注册表/服务/ACL 等）走 PowerShell，
  // 本工具始终 Unix 语法，不接受 cmd/PowerShell 方言。
  const isWindows = (input.platform ?? process.platform) === "win32";

  return [
    "Executes a bash command and returns its output.",
    "",
    ...(isWindows
      ? [
          "- On Windows this tool runs Git Bash (POSIX sh) — not cmd.exe and not PowerShell. Use Unix shell syntax: `/dev/null` not `NUL`, forward slashes in paths, `$VAR` not `%VAR%` or `$env:VAR`. For Windows-native surfaces (registry, services, ACLs, event logs) use the PowerShell tool instead.",
          "",
        ]
      : []),
    "- Working directory persists between calls, but prefer absolute paths — `cd` in a compound command can trigger a permission prompt. Shell state (env vars, functions) does not persist; the shell is initialized from the user's profile.",
    `- IMPORTANT: Avoid using this tool to run ${avoidCommands} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user.`,
    `- \`timeout\` is in milliseconds: default ${input.defaultTimeoutMs}, max ${input.maxTimeoutMs}.`,
    "- `run_in_background` runs the command detached: it keeps running across turns and re-invokes you when it exits. No `&` needed.",
    "",
    "# Git",
    "- Interactive flags (`-i`, e.g. `git rebase -i`, `git add -i`) are not supported in this environment.",
    "- Use the `gh` CLI for GitHub operations (PRs, issues, API).",
    "- Commit or push only when the user asks. If on the default branch, branch first.",
  ].join("\n");
}
