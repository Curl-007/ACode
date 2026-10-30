# 子代理对父会话的继承修正（workspaceRoot 锚定 + resume 模式跟随）

权限继承修复项。修复「主 agent 完全访问（yolo）时子智能体仍弹审批」的两个已核实根因：
子运行时的 workspaceRoot 被误锚定到父会话漂移后的 cwd（`breaker.pathEscapeWrite` 误报），
以及 SendMessage/冷恢复时子模式被创建时刻落库的旧值覆盖。

## 背景（两个已核实的洞）

1. **workspaceRoot 误锚定（`breaker.pathEscapeWrite` 误报）**：`AgentRuntime` 构造器把
   `workspaceRoot` 无条件锁为构造时的 `workingDirectory`；`setWorkingDirectory` 只漂
   `workingDirectory`、不动 `workspaceRoot`（`methods/config.ts`，刻意的工作区身份不变量）。
   但子代理派生传进 child config 的是父 runtime 的**当前** `workingDirectory`（可能已被
   Bash `cd` 漂移，`tool/handlers/agent.ts` → `subagent/runner.ts` →
   `runtime/methods/subagent.ts`），父的不可变 workspaceRoot 虽一路传到 spawn request，
   却从未用于构造 child。父 `cd` 进子目录后派生子代理 → child 的 workspaceRoot = 漂移后的
   子目录 → 子代理写**真实工作区内**、漂移目录外的文件即命中 `breaker.pathEscapeWrite`
   （旁路免疫熔断器，任何模式都弹，含 yolo，
   `managed-policy-floor-and-bypass-immune-breakers.md` R2）。主 agent 写同一路径不弹
   （其 root 未漂移）→ 表现为「子智能体不继承权限」。
2. **resume 模式覆盖**：SendMessage/冷恢复子会话时，spawn 路径无 `modeOverride` 调
   `resumeFromStore`；`runtime/methods/resume.ts` 用子会话**创建时刻**落库的旧模式
   （`runtime/methods/events.ts` 的落库点）覆盖刚按父当前模式解析的 childMode。场景：
   build 时派生后台 agent → 用户授完全访问 → 对该 agent SendMessage → 以 build 复活 →
   重新弹审批。

已核实**不是**洞的部分（保持现状，测试钉住）：

- 新建前台/后台 general-purpose 子代理在父为 yolo 时继承 yolo
  （`resolveSubagentPermissionMode` 的 undefined → parentMode 分支，
  `subagent-policy-floor-inheritance.md` R3 已钉住）。
- workflow / swarm child 锚定应用级固定 cwd（create-app 的 workingDirectory，不经会话
  cd 漂移），不受洞 1 影响；其 `mode: "yolo"` 为设计内硬编码。
- 熔断器对工作区外目标的 ask 本体：洞 1 修复后，写真实工作区之外**仍然弹**——这是
  安全加固 P2 的有意设计，本项不松动。
  **（2026-10-14 校准：managed-policy-floor-and-bypass-immune-breakers.md R6 裁决后，
  yolo 下 pathEscapeWrite 不再降级 ask——本条「仍然弹」仅对非 yolo 的 allow 来源
  （build/edit 项目 allow 规则、allowedTools 等）继续成立。洞 1 的锚定正确性不受影响：
  workspaceRoot 仍是 projectId / project memory 根推导 / 非 yolo 熔断判定的身份锚，
  回归钉移到熔断器纯函数层（模式无关）。）**

## 产品规则

### R1 子运行时的 workspaceRoot 唯一来源 = 父 runtime 的不可变 workspaceRoot

- `AgentRuntimeConfig` 增加可选 `workspaceRoot?: string`；构造器归一化为
  `config.workspaceRoot ?? workingDirectory`。缺省路径（主会话、workflow child 等全部
  既有构造点）行为不变。
- spawn 路径把 `request.workspaceRoot`（= 父 runtime 构造期锁定的根）传入 child config。
- child 的 `workingDirectory` 仍是父的当前 cwd：相对路径解析、envInfo 展示 cwd、
  `cd` 语义不变；只有工作区身份（权限熔断、projectId、project memory 根推导）锚定真实根。
- workspaceRoot 的不变量与 workingDirectory 相反：构造期锁定、runtime 生命周期内不变
  （唯一写入方 = 构造函数），与 `runtime/internal.ts`「身份与构造期配置」簇语义一致。

### R2 resume 时子模式跟随父当前档

- spawn 的 resume 分支：`childMode !== "plan"` 时调
  `resumeFromStore({ modeOverride: childMode, ... })`。`modeOverride` 是 resume.ts 既有
  最高优先级通道（压过 SessionModeChanged 事件 reduce 与持久化 execution-state entry）。
- `childMode === "plan"`（profile `permissionMode` 地板，或父处于 plan）不传 override：
  `resolveExecutionState({ mode })` 对非 plan 模式把 `planEnabled` 归 false
  （`packages/shared/src/execution-state.ts`），传了会静默拆 plan 地板；plan 状态由子会话
  创建时刻落库的 execution-state entry 正确恢复。
- override 仅作用于本次 resume 的内存态，不回写持久化 entry：子会话永远经父 spawn 路径
  恢复，每次恢复都按父当前档重解，不存在需要依赖的陈旧持久化模式。

## 状态所有者与调用链

```
父 AgentRuntime
  ├─ workingDirectory（可漂移：Bash cd → setWorkingDirectory）──→ child config.workingDirectory
  └─ workspaceRoot（构造期锁定，唯一写入方 = 构造函数）──────────→ child config.workspaceRoot（R1）
       └─ child 构造器归一化：config.workspaceRoot ?? workingDirectory

父 config.mode / planEnabled（当前档）
  └─ resolveSubagentPermissionMode → childMode
       ├─ 新建：child config.mode / planEnabled（既有链路，不动）
       └─ resume：childMode !== "plan" → resumeFromStore modeOverride（R2）
```

## 接口

- `core/src/runtime/types.ts`：`AgentRuntimeConfig.workspaceRoot?: string`。
- `core/src/runtime/agent-runtime.ts`：构造器归一化（R1）；导出纯函数
  `resolveRuntimeWorkspaceRoot` 供测试钉住优先级（与 `resolveSubagentPermissionMode`
  导出同一先例）。
- `core/src/runtime/methods/subagent.ts`：child config 传 `workspaceRoot`；resume 分支按
  R2 传 `modeOverride`；导出纯函数 `resolveSubagentResumeModeOverride` 供测试钉住
  plan 豁免边界。
- 其余 `AgentRuntimeConfig` 构造点零改动（缺省回退 = 现状）。

## 验收场景

见 `apps/acode-cli/tests/subagent-parent-inheritance.test.mjs`：

1. `resolveRuntimeWorkspaceRoot`：显式 `workspaceRoot` 优先；缺省/空白回退
   `workingDirectory`（既有构造点兼容）。
2. 漂移场景（决策层，与 executor 喂给 PermissionService 的 context 同形）：root=工作区根、
   cwd=root/sub 时，yolo 下写 root 内（sub 外）路径 → allow、无 `breaker.pathEscapeWrite`；
   ~~写 root 外路径 → 仍 ask~~（**R6 校准：yolo 下改为 allow 直通**）；对照组
   workspaceRoot=root/sub（缺陷形态）的误报鉴别**移到熔断器纯函数层**（模式无关，
   钉住锚定正确性对非 yolo allow 来源与其余 workspaceRoot 消费方仍然 load-bearing）。
3. `resolveSubagentResumeModeOverride`：非 plan childMode 原样透出（resume 后跟随父当前
   yolo）；`"plan"` 返回 undefined（plan 地板不拆，由持久化 execution-state entry 恢复）。

## 完全访问事后传播（2026-10-30 增补，用户裁决修复）

**R7 裁决**：根会话授予完全访问（`grantPermissionFullAccess` 弹窗路径，或
`applyRuntimeExecutionState` 切 bypass 档）时，**同步广播到同谱系活 child runtime**
（含孙级，递归）。根因登记：授权原只写根 runtime `config.mode`
（permission-full-access.ts / execution-state.ts），child 模式在 spawn 时冻结
（subagent.ts `config.mode = childMode`），导致「先派子代理后授权」场景子代理逐次
弹审批、且子弹窗不提供完全访问选项（用户实测三连弹复现）。

- **通道**：父 runtime 是活 child runtime 注册表唯一所有者（spawn 登记 / child turn
  finally 注销，WeakMap 持有不延寿）；广播复用 `applyRuntimeExecutionState`——child
  会话持久化、`SessionModeChanged` 事件审计、托管策略地板校验全部沿用既有语义，
  不新写第二条模式写入路径。
- **语义边界**：
  1. child `planEnabled` 不随广播改变（与根授权保留 planEnabled 同语义；plan vessel
     不被静默解除）。
  2. 托管策略地板拒绝（modePolicyForbidden）或 child 授权 busy：warn-skip 该 child，
     不回滚根授权（部分传播优于整体失败，地板仍是底线）。
  3. child 已在 bypass 档：`applyRuntimeExecutionState` 同档早退，无事件刷屏。
  4. 熔断器 bypass-immune 面（sensitiveRead / bashRootDelete / catastrophic）在 yolo
     下照弹——安全加固 P2 不变量，不随本修复拆除。
- **子弹窗放开**：`interaction-broker.ts` 与 `product-projection.ts` 的 origin 抑制
  移除；子来源弹窗的「完全访问」选项选中后走根授权 + 广播（origin child 一并收敛）。
  `optionsPolicy` 抑制保留（托管选项策略仍是地板）。

**验收场景**：
1. 先派后授：build 档派子代理 → 根切完全访问 → 子代理后续域外 Write/Read 静默
   （无 PermissionRequested；决策日志 child mode=yolo）。
2. 子来源弹窗含 fullAccess 选项；选中后全谱系收敛（含发起请求的 child）。
3. 对照：build 档（未授权）域外写仍 ask；授权前 child 的弹窗逐次出现（旧语义保留到授权时刻）。
4. plan child 不被广播解除 plan（planEnabled 保持 true，mode 升 yolo）。
5. 托管 disable-bypass 策略下广播对该 child skip + warn，根授权成功。

## 不在本项范围

- **模型（非权限）继承的边界**：本 spec 只管 workspaceRoot 锚定与 resume 模式跟随。
  子代理模型选择优先级（override > profile > 父继承）归 `resolveSubagentSelection`；
  AgentTeams 成员的 `inheritCaptainModel` 两分支与 fail-closed 标记见
  `agent-teams-derived-config.md` R3/R4（2026-10-15 合入批次）。
- 熔断器对工作区外目标的 ask 本体（安全加固 P2 不变量）。
- workflow / swarm / memory agent 的构造点（锚定应用级 cwd / deny broker，设计内）。
