# Runtime session persistence owner

状态：CLI-05 最小写权限切片（2026-10-09）。本批只收敛 `AgentRuntime.sessionPersisted`；
turn、workflow、session store 的其余状态和写入协议保持原边界。

## 规则

`sessionPersisted` 表示当前 runtime 已经把 session shell 写入权威 `SessionStore`。它是
runtime 内的会话事实，不是协议层或 handler 的派生缓存。唯一保存方是
`RuntimeSessionPersistenceOwner`（WeakMap 按 runtime 绑定），外部只能通过只读 getter 观察，
并通过 `markPersisted()` 提交单调的 `false → true` 转换。

写入顺序保持不变：`ensureSessionPersisted` 完成 session、model selection、shell 和 execution
state 写入后调用 `markPersisted()`，随后追加首条 title 事件；`resumeFromStore` 完成恢复快照
和 execution state hydration 后调用同一端口，再追加 `SessionResumed`。写入失败不得提前标记，
owner 不提供 reset 或任意布尔 setter。

```text
SessionStore writes ──success──> markPersisted() ──> append lifecycle event
        └─ failure ─────────────> state remains false; retry remains possible
```

读面（execution state persistence、session shell environment、target continuation、事件
投影）只能使用 `AgentRuntimeInternal.sessionPersisted` getter。owner 不负责执行 store IO、
事件发布或跨 runtime 同步；关闭、resume/rewind 的其他代际规则不在本批扩展。

## 验收

- owner 初始为 `false`，首次 `markPersisted()` 返回 `true`，重复调用返回 `false` 且保持 `true`。
- getter、owner port 和 reservation 类似地不可替换；直接赋值在运行时抛 `TypeError`，
  `AgentRuntimeInternal` 的 TypeScript 负例拒绝写入。
- `ensureSessionPersisted` 和 `resumeFromStore` 的既有写入顺序与失败重试语义不变；core
  typecheck、runtime state ownership focused tests、lint 和 changed architecture check 通过。

