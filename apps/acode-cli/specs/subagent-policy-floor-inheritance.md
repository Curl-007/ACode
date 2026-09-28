# 策略地板的进程级结构化继承（subagent / memory agent / 便利覆盖交互）

安全加固 P2 补丁项。修复托管策略地板（`managed-policy-floor-and-bypass-immune-breakers.md`）
落地后发现的三个结构性旁路，把「地板对所有权限决策生效」从构造器纪律变成进程级不变量。

## 背景（三个已核实的洞）

1. **Explore 子代理旁路地板**：`subagent.ts` 对 built-in Explore 构造
   `new PermissionService(defaultPermissionConfig)`（独立只读权限配置），且
   `resolveSubagentPermissionMode` 给 Explore 的缺省模式是 **yolo**（设计如此：
   只读工具面免确认）。该实例没有 policyFloor → 策略 deny/ask 规则与
   `disableBypassPermissionsMode` 对 Explore 的权限决策完全不生效。
2. **memory agent 同构旁路**：`project-memory-agent.ts` 的工具执行器同样
   `new PermissionService(defaultPermissionConfig)` + `getMode: () => "yolo"`。
3. **便利覆盖可撤销安全 ask**：`applyMemoryFilePermission` 在 checkPermission 之后
   把「memory 目录内的 .md 写入」升级为 allow；其 `preservesExistingPermissionDecision`
   只保护 deny、alwaysAsk、`rule.project.ask`、`hook.PreToolUse.ask`——
   **`rule.policy.ask` 与 `breaker.*` 的 ask 会被覆盖回 allow**。组合场景：
   memoryRoot 在 workspaceRoot 之外时，memory 写入命中 `breaker.pathEscapeWrite`
   → ask → memory override → allow，熔断被静默撤销；策略地板的 ask 规则同理。

已核实**不是**洞的部分（保持现状，测试钉住）：
- `resolveSubagentPermissionMode` 对 request 显式 `yolo`/`bypassPermissions` 走
  default 分支回落 parentMode——子代理 profile 无法把模式抬到父会话之上；
  `"auto"`/`"plan"` 覆盖只会更严（auto 当前全拒、plan 只读）。
- 旁路免疫熔断器在 checkPermission 收口处评估、与 config 无关，Explore/memory
  的自建实例同样受熔断保护（洞 3 只影响熔断结果的后续覆盖）。
- 硬禁用（disallowedTools）对 Explore 有工具面级等价物：`toolDisallowlist` 随
  child runtime config 下发并参与 `resolveSubagentToolAllowlist`，被禁工具在
  子代理工具面直接不可见。

## 产品规则

### R1 策略地板是进程级不变量，不是构造参数选项

- core 新增进程级注册点 `process-policy-floor.ts`：
  `setProcessManagedPolicyFloor(floor | undefined)` / `getProcessManagedPolicyFloor()` /
  `resetProcessManagedPolicyFloorForTest()`（与 `setOfficialServiceSwitches`、
  CUA broker capture 同一「进程单例 + 测试重置」模式；一个进程一个 app 一份配置）。
- `create-app.ts` 在构造 PermissionService 的同一处注册
  `configResult.config.permission.policy`（含 undefined = 清除，保证测试/多实例语义）。
- `PermissionService` 解析链：`this.config.policyFloor ?? getProcessManagedPolicyFloor()`。
  显式构造参数优先（测试与特殊实例可覆盖）；缺省时**任何**实例——包括
  `defaultPermissionConfig` 构造的 Explore/memory 实例——自动携带进程地板。
  策略 deny/ask（R3 步骤 0/1）、yolo 直通跳过（disableBypassPermissionsMode）、
  `isBypassPermissionsModeDisabled()`（R4 模式边界）三处统一走该解析链。
- 效果：Explore 子代理与 memory agent 无需改构造点即被地板覆盖；未来任何
  `new PermissionService(...)` 站点结构性免疫此洞（不依赖构造器纪律）。

### R2 安全地板类 ask 不可被便利覆盖撤销

- `preservesExistingPermissionDecision` 扩展保护集：
  - `rule.policy.ask`（托管策略地板）；
  - `ruleId.startsWith("breaker.")`（旁路免疫熔断器）。
- 语义：memory 文件便利放行只能升级**模式/规则推导出的** allow-able ask，
  永远不能撤销「安全地板」类 ask。deny 保护集不变。

### R3 子代理模式天花板（现状钉住，不改行为）

- request 显式 `yolo`/`bypassPermissions` → 回落 parentMode（已实现，导出
  `resolveSubagentPermissionMode` 供测试钉住）。
- Explore 缺省 yolo 保留（只读工具面 + 熔断器 + R1 后的地板覆盖，三层兜底）；
  `disableBypassPermissionsMode=true` 时 Explore 的 yolo 直通同样失效、落 build 判定
  （只读工具仍 allow，副作用动作 ask → deny broker → 拒绝，行为收敛正确）。

## 状态所有者与调用链

```
create-app（唯一注册点）
  └─ setProcessManagedPolicyFloor(config.permission.policy)
       ├─ PermissionService（主会话，显式 config.policyFloor 同源）
       ├─ PermissionService（Explore 子代理，defaultPermissionConfig → 进程地板兜底）
       └─ PermissionService（memory agent，同上）
            └─ checkPermission 收口 → applyMemoryFilePermission（R2 保护集）
```

## 接口

- `core/src/permission/process-policy-floor.ts`：
  `setProcessManagedPolicyFloor(floor?: ManagedPolicyFloorData)`、
  `getProcessManagedPolicyFloor(): ManagedPolicyFloorData | undefined`、
  `resetProcessManagedPolicyFloorForTest(): void`
- `core/src/runtime/methods/subagent.ts`：导出 `resolveSubagentPermissionMode`（纯函数）。
- `PermissionService` 公开接口不变。

## 验收场景

见 `apps/acode-cli/tests/subagent-policy-floor.test.mjs`：

1. 进程地板注册后，`new PermissionService(defaultPermissionConfig)`（Explore/memory
   形态）对策略 deny 工具返回 deny（rule.policy.deny）、对策略 ask 工具返回 ask。
2. `disableBypassPermissionsMode=true` 经进程地板生效：defaultPermissionConfig 实例
   的 yolo 不再直通（副作用动作 ask）；`isBypassPermissionsModeDisabled()` 为 true。
3. 显式 `config.policyFloor` 优先于进程地板；`resetProcessManagedPolicyFloorForTest`
   后进程地板不再泄漏到后续实例。
4. memory 便利覆盖不撤销安全 ask：`rule.policy.ask` 与 `breaker.pathEscapeWrite`
   的 ask 在 applyMemoryFilePermission 后保持 ask；普通 `mode.build.sideEffect` ask
   对 memory .md 目标仍照常升级 allow（零回归）。
5. 子代理模式天花板：request 显式 yolo/bypassPermissions 回落 parentMode；
   undefined + Explore → yolo；undefined + 非 Explore → parentMode；auto/plan 照旧。
6. 无地板进程（未注册/已重置）：defaultPermissionConfig 实例行为与改动前一致
   （yolo 直通、无 policy 判定）。

## 不在本项范围

- Explore 子代理的 yolo 缺省改模式（设计保留，见 R3；只读工具面 + 三层兜底）。
- memory agent 的 deny broker 语义（ask→deny 是其隔离设计，不动）。
- 多 app 同进程场景（不存在：一个进程一个 createACodeApp，与 setOfficialServiceSwitches
  同一前提）。
