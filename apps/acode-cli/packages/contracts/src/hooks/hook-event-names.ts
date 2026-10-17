// Hook 事件名与决策词汇的叶子文件（specs/hook-event-surface.md）。
// 拆分依据：index.ts 与 hook-event-io.ts 都需要引用事件名，抽出叶子避免
// index ↔ io 的值循环；同时让 index.ts 回到 oxlint max-lines(400) 门禁之内。
// 公开 API 不变：contracts 根 index 经 hooks/index.ts 的 `export *` 原样再导出。

export const HookEventName = {
  SessionStart: "SessionStart",
  UserPromptSubmit: "UserPromptSubmit",
  PreToolUse: "PreToolUse",
  PermissionRequest: "PermissionRequest",
  PostToolUse: "PostToolUse",
  PostToolUseFailure: "PostToolUseFailure",
  PostToolBatch: "PostToolBatch",
  Stop: "Stop",
  StopFailure: "StopFailure",
  PreCompact: "PreCompact",
  PostCompact: "PostCompact",
  PreModelSwitch: "PreModelSwitch",
  PostModelSwitch: "PostModelSwitch",
  SessionEnd: "SessionEnd",
  TaskCreated: "TaskCreated",
  TaskCompleted: "TaskCompleted",
  CwdChanged: "CwdChanged",
} as const;

export type HookEventName = (typeof HookEventName)[keyof typeof HookEventName];

export const HookOutcome = {
  Success: "success",
  Blocked: "blocked",
  Failed: "failed",
  Cancelled: "cancelled",
  TimedOut: "timed_out",
} as const;

export type HookOutcome = (typeof HookOutcome)[keyof typeof HookOutcome];

export const HookSourceKind = {
  User: "user",
  Plugin: "plugin",
  Project: "project",
  Internal: "internal",
} as const;

export type HookSourceKind = (typeof HookSourceKind)[keyof typeof HookSourceKind];

export const HookPermissionDecision = {
  Allow: "allow",
  Ask: "ask",
  Deny: "deny",
} as const;

export type HookPermissionDecision =
  (typeof HookPermissionDecision)[keyof typeof HookPermissionDecision];
