// ============================================================
// PowerShell Tool - provider description（specs/powershell-tool.md R1）
// ============================================================
// 描述全部自撰；要点形态参照还原工程证据（prompts/0078 工具描述、0576/1697
// edition 注记），未拷贝任何上游文本。模型面文本恒英文（specs/prompt-language-policy.md R3）。

export type PowerShellEdition = "pwsh" | "windows-powershell";

const EDITION_NOTES: Record<PowerShellEdition, string[]> = {
  pwsh: [
    "PowerShell edition: PowerShell 7+ (pwsh).",
    "   - `&&` / `||` pipeline chain operators are available and work like bash; ternary (`?:`), `??` and `?.` are available.",
    "   - Default file encoding is UTF-8 without BOM.",
  ],
  "windows-powershell": [
    "PowerShell edition: Windows PowerShell 5.1 (powershell.exe).",
    "   - `&&` / `||` are NOT available (parser error). Run B only if A succeeds with `A; if ($?) { B }`; chain unconditionally with `A; B`.",
    "   - Ternary (`?:`), `??` and `?.` are NOT available; use `if/else` and explicit `$null -eq` checks.",
    "   - Avoid `2>&1` on native executables: 5.1 wraps their stderr in ErrorRecords and sets `$?` to false even on exit 0. stderr is already captured for you.",
    "   - `>` / `Out-File` default to UTF-8 with BOM; `Set-Content` / `Add-Content` default to ANSI — pass `-Encoding utf8` explicitly for files other tools will read.",
    "   - `ConvertFrom-Json` returns a PSCustomObject (`-AsHashtable` is not available).",
  ],
};

export function createPowerShellProviderDescription(input: {
  defaultTimeoutMs: number;
  edition: PowerShellEdition;
  maxTimeoutMs: number;
}): string {
  return [
    "Executes a PowerShell command and returns its output. This is the Windows-native shell surface: registry (HKLM:/HKCU:), services, ACLs, event logs, WMI and other Windows-native commands belong here; POSIX-style git/build workflows run in the Bash tool (Git Bash on Windows) instead.",
    "",
    "- Working directory persists between calls, but prefer absolute paths. Shell state (variables, functions, env changes) does NOT persist: every call is a fresh `-NoProfile -NonInteractive` process.",
    "- IMPORTANT: This tool is for terminal operations (git, npm, docker, native exes, PS cmdlets). Do NOT use it for file operations — use the dedicated Read/Write/Edit/Glob/Grep tools instead of Get-Content/Set-Content/Select-String/Get-ChildItem -Recurse, and output text directly instead of Write-Output/Write-Host.",
    `- \`timeout\` is in milliseconds: default ${input.defaultTimeoutMs}, max ${input.maxTimeoutMs}. Write a clear, concise \`description\` of what the command does. Output beyond the inline budget is truncated and persisted to a file.`,
    "- `run_in_background` runs the command detached: it keeps running across turns and re-invokes you when it exits.",
    "",
    "Before executing:",
    "1. Directory verification: if the command creates directories or files, first verify with `Get-ChildItem` (or `Test-Path`) that the parent directory exists and is the right location.",
    "2. Always quote file paths that contain spaces with double quotes.",
    "",
    "PowerShell syntax notes:",
    "   - Variables use the `$` prefix (`$myVar = \"value\"`); the escape character is the backtick (`` ` ``), not backslash.",
    "   - Cmdlets are Verb-Noun (`Get-ChildItem`, `Set-Location`, `New-Item`, `Remove-Item`); common aliases: ls, cd, cat, rm.",
    "   - The pipe `|` passes objects, not text: filter/transform with `Select-Object`, `Where-Object`, `ForEach-Object`.",
    "   - String interpolation: `\"Hello $name\"` or `\"Hello $($obj.Property)\"`.",
    "   - Registry access uses PSDrive prefixes: `HKLM:\\SOFTWARE\\...`, `HKCU:\\...` — NOT raw `HKEY_LOCAL_MACHINE\\...`.",
    "   - Environment variables: read `$env:NAME`, set `$env:NAME = \"value\"` (NOT `Set-Variable`, NOT bash `export`; there is no inline `VAR=x cmd` prefix).",
    "   - Call a native exe whose path contains spaces with the call operator: `& \"C:\\Program Files\\App\\app.exe\" arg1 arg2`.",
    "",
    ...EDITION_NOTES[input.edition],
    "",
    "Unix commands that do NOT exist in PowerShell — use the equivalent:",
    "   - head/tail → `Get-Content file -TotalCount N` / `-Tail N`; piped: `| Select-Object -First N` / `-Last N`.",
    "   - which → `(Get-Command name).Source`; wc -l → `(Get-Content file | Measure-Object -Line).Lines`.",
    "   - touch → `if (-not (Test-Path p)) { New-Item -ItemType File p }` (NEVER `New-Item -Force` on an existing file — it truncates).",
    "   - mkdir -p → `New-Item -ItemType Directory -Force path`; rm -rf → `Remove-Item -Recurse -Force path`; ln -s → `New-Item -ItemType SymbolicLink -Path link -Target target`.",
    "   - chmod/chown → not applicable on Windows; use `icacls` only when ACL changes are required.",
    "   - `2>/dev/null` → `2>$null` (usually unnecessary — stderr is captured for you); `VAR=x cmd` → `$env:VAR = 'x'; cmd`.",
    "   - Bash control flow (`if [ -f x ]`, `for x in *`, backtick ``cmd`` substitution) is a parser error — use `if (Test-Path x)`, `foreach ($x in ...)`, `$(cmd)`.",
    "",
    "Exit codes: `-ErrorAction SilentlyContinue` suppresses error OUTPUT but a failed cmdlet still reports exit 1 from this tool. To make a cmdlet failure truly non-fatal, promote and swallow it: `try { Cmdlet ... -ErrorAction Stop } catch {}`.",
    "",
    "Interactive/blocking commands (this tool runs -NonInteractive with stdin on the null device — prompts read EOF or fail immediately):",
    "   - NEVER use `Read-Host`, `Get-Credential`, `Out-GridView`, `$Host.UI.PromptForChoice` or `pause`.",
    "   - Destructive cmdlets (`Remove-Item`, `Stop-Process`, `Clear-Content`, ...) may prompt for confirmation: add `-Confirm:$false` when the action should proceed; use `-Force` for hidden/read-only items.",
    "   - Never open interactive editors (`git rebase -i`, `git add -i`).",
    "",
    "Multiline strings to native exes (commit messages, file content): use a single-quoted here-string so `$` and backticks stay literal; the closing `'@` MUST be at column 0 on its own line (indenting it is a parse error):",
    "<example>",
    "git commit -m @'",
    "Commit message here.",
    "Second line with $literal dollar signs.",
    "'@",
    "</example>",
    "   - Prefer `@'...'@` (literal) over `@\"...\"@` (interpolated) unless you need expansion. For args PowerShell parses as operators use the stop-parsing token: `git log --% --format=%H`.",
    "",
    "When issuing multiple commands:",
    "   - Independent commands that can run in parallel: make multiple tool calls in a single message.",
    "   - Dependent commands: chain them in one call (see edition-specific chaining notes above). Use `;` only when later commands should run even if earlier ones fail.",
    "   - Do NOT separate commands with newlines (newlines are fine inside quoted strings and here-strings).",
    "",
    "Do NOT prefix commands with `cd` or `Set-Location` — the working directory is already set to the correct project directory.",
    "",
    "# Git",
    "- Prefer creating a new commit over amending an existing one.",
    "- Before destructive operations (git reset --hard, git push --force, git checkout --), consider a safer alternative that achieves the same goal.",
    "- Never skip hooks (--no-verify) or bypass signing (--no-gpg-sign, -c commit.gpgsign=false) unless the user explicitly asked; if a hook fails, fix the underlying issue.",
  ].join("\n");
}
