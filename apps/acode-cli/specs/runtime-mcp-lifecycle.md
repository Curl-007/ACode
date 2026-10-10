# MCP runtime 初始化生命周期

状态：CLI-05 后续 bounded slice（2026-10-09）。本 spec 只收敛同一个
`AgentRuntime` 内 MCP tool 注册的并发与终态，不改变 MCP trust、server 启动或权限规则。

## 所有者与不变量

- `AgentRuntime` 是 MCP 初始化状态的唯一 owner；调用方只能调用
  `initializeMcp()`，不能写 `mcpInitialized`、`mcpToolsRegistered` 或初始化 promise。
- 同一 runtime 同时只有一个 registration attempt。第一个调用创建 in-flight promise，后续调用
  必须等待同一个 promise，不得重复调用 `registerMcpTools`。
- 启动失败仍按现有 fail-closed 语义完成初始化：工具不注册，后续调用观察到已完成状态，不能
  在同一 runtime 反复 spawn 或注册。
- MCP disabled、没有 port 或没有 configured server 的路径也必须收敛到一次完成状态。

## 事件顺序

```text
initializeMcp → claim in-flight owner → await startup → register tools once → commit registered
                         └──────────── later callers await same promise ────────────┘
```

初始化 promise 只保护同一 runtime 的生命周期；resume/restart 会构造新 runtime，自然获得新的
初始化 owner。没有第二份工具注册表，也不以超时解决并发。

## 验收场景

1. 两个并发 `initializeMcp()` 只调用一次 `registerMcpTools`，并都在完成后返回。
2. 启动拒绝/异常仍只结束一次 registration attempt；第二次调用不重新连接或注册。
3. 已注册状态下的后续调用不读取 startup、不触发 registry 变化。
