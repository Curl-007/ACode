# Host running task count：唯一所有者与事件顺序

状态：已实施（2026-10-05，深度审查 P1「running task count 双写入方收口」落地件）。
代码：`packages/desktop/src/host/hostWorkspaceTaskTracker.ts`（所有者）、`packages/desktop/src/host/index.ts`（接线）。
测试：`packages/desktop/tests/host-workspace-task-tracker.test.mjs`。

## 事实与所有者

「Host 上有多少任务在跑」由两个分量构成，**唯一存储处是 `createHostWorkspaceTaskTracker` 返回的 tracker 实例**：

1. **workspace 任务计数**：按 `resolveWorkspaceKey(context)` 分桶、按 taskId 去重的活跃集合。只由 task ready 事件驱动 begin/finish——`sendPrompt` resolve 只是 ACK，不能代表 Agent 已空闲（否则共享 WSL Host 会在关闭 workspace 时误杀仍在执行工具的 Agent）。
2. **无归属 RPC 计数（unattributed RPC）**：`sendPrompt` 包装器在 task meta 缺失或参数畸形时的兜底，仅覆盖 RPC 生命周期（调用 → ACK/resolve）。无法安全伪造 workspace identity，故不进 workspace 桶、不参与 `clearWorkspace`、不参与 workspace runtime 释放裁决；只进入 host 级总量供 Main 的退出诊断聚合。

host/index.ts 不得再持有模块级影子计数器（历史上 `untrackedPromptRpcCount` 与 tracker 双写同一事实，加减散落在 Proxy 包装器三处）。

## 事件顺序

任何计数变更（workspace begin/finish/clearWorkspace、unattributed begin/finish）都按固定顺序发布：

```text
变更 → workspace 级 report(event)（postMessage WorkspaceRunningTaskCountChanged
       + windowRemoteConnectionRegistry.setWorkspaceRunningTaskCount）
     → host 级 reportTotal(total)（runtimeTaskReporter.onRunningTaskCountChanged
       → Main hostRunningTaskCountMap → getRunningAgentSessionCount() 退出裁决）
```

无归属 RPC 变更没有 workspace 事件，只触发 host 级 reportTotal。

## 不变量

- `getTotalRunningTaskCount() === Σ(workspace activeTaskIds.size) + unattributedRpcCount`。
- `getRunningTaskCount(context)` 只含 workspace 分量，永不含无归属 RPC。
- 两个分量都不得为负（finish/减法路径 `Math.max(0, …)`）。
- 同一 taskId 在同一 workspace 重复 begin 幂等（返回 false，不重复计数）。

## 验收场景

见测试文件：workspace 计数与事件顺序、总量包含无归属分量、workspace 级排除无归属分量、clearWorkspace 不清无归属分量、负数防护、多 workspace 汇总。
