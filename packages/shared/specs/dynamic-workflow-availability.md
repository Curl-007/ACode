# 动态工作流可用性（灰度门的缺省档位与三端一致性）

规定「动态工作流（dynamic workflow / dwf）对当前客户端是否可用」这一个判定的取值域、优先级、
缺省档位、所有者与三端（Host services / Desktop main / UI）的一致性契约。本文件是
`dynamic-workflow-feature.ts` 的行为规格：那个模块只放共用的取值域、归一化与快照形状，
读取远端、按构建档位改写环境、以及消费开关做减法都各有自己的 owner，都不在这里。

## 关键事实与命名裁决（务必先读）

- **这是一次缺省档位的反转，不是新增开关。** 取值域（`disabled | onDemand | alwaysOn`）、
  优先级链、三端接线、以及关闭态的四处减法全部保持不变；只有「远端没说、环境也没说时取什么」
  从 `disabled` 改为 `alwaysOn`。
- **裁决：缺省改为 `alwaysOn`，而不是让 Desktop 在 production 档写入 `alwaysOn`。**
  理由是优先级链的性质：环境变量是 **override**，它**压过远端**（见「产品规则」的优先级）。
  若 production 档写入 `alwaysOn`，服务端下发 `disabled` 将被本地环境盖掉，远端失去否决权——
  那与「灰度可由服务端回收」的既有契约直接冲突。只改缺省值时，production 的路径是
  「环境缺席 → 远端说了算 → 远端也没说才落 `alwaysOn`」，远端否决权完整保留。
- **因此 Desktop 的三档环境逻辑一行不改。** `desktopRuntimeEnv.ts` 的
  `resolveDynamicWorkflowModeHostEnv` 继续是：未打包 dev 透传 shell 合法值、打包 preview 固定
  写 `alwaysOn`、打包 production 删除继承值且永不写入。「Main 是唯一决策者、对这个键只有写和删
  两种动作、绝不原样透传」这条原则不受本次改动影响。
- **本改动使 dwf 的缺省档位与闲时任务（Off-Peak）灰度不再一致。** 原注释里
  「fail-closed，与闲时任务灰度一致」是两者共享同一裁决的记录；反转后 dwf 是 fail-open，
  Off-Peak 仍 fail-closed。这是刻意的分叉，不是遗漏：dwf 的工具面全部在本机执行，
  灰度是**发布节奏控制**而非安全边界；Off-Peak 会把任务投递到远端空闲算力队列，
  它的 fail-closed 是资源与计费边界。两者不该继续共用一个缺省值。
- **`onDemand` 目前与 `alwaysOn` 行为相同。** `isDynamicWorkflowModeEnabled` 只判
  `mode !== "disabled"`，两个非 disabled 档位折叠成同一个布尔。将来 `onDemand` 有独立行为时
  只调整消费侧，取值域与优先级不动。

## 产品规则

- **R1 取值域**：`DYNAMIC_WORKFLOW_MODES = ["disabled", "onDemand", "alwaysOn"]`，闭集。
  任何非字符串、超出闭集、或仅空白差异的输入都不算合法值（`normalizeDynamicWorkflowMode`
  先 `trim` 再按闭集判定），非法即视为「没说」。
- **R2 缺省档位**：远端未下发该 key、下发了非法值、或请求失败时，取 `alwaysOn`
  （`DEFAULT_DYNAMIC_WORKFLOW_MODE`）。即 **fail-open**。
- **R3 优先级**：本地环境覆盖 > 远端合法值 > 缺省。三段严格有序，前一段命中即返回，
  后一段不再参与。特别地：远端请求**成功但未下发**该 key，等同于「远端没说」，落缺省——
  服务端撤掉 key 不再等于关闭（这与反转前的语义相反，是 R2 的直接推论）。
- **R4 远端否决权**：服务端显式下发 `mode: "disabled"` 时，在无本地环境覆盖的档位上
  （production、以及未设置该环境变量的 dev/Web/server Host）必须关闭。缺省反转**不得**
  削弱这条。
- **R5 布尔折叠唯一实现**：「mode → 是否可用」只在 `isDynamicWorkflowModeEnabled` 里折叠一次，
  并由 `createDynamicWorkflowClientConfig` 落成 `enabled` 字段。消费侧一律读 `enabled`，
  不得各自重写 `mode !== "disabled"`。
- **R6 来源可观测**：快照必须携带 `source ∈ {"remote", "override", "default"}`，
  供 UI 与日志区分「服务端关」与「本地覆盖」。三个值分别对应 R3 的三段。
- **R7 关闭态的减法面**（本次不改，仅记录契约）：`enabled` 为假时，dwf 的十个工具不注册、
  `dynamic-workflows` 内置技能从发现中剔除、`/workflow` 从命令目录过滤、桌面 Automations 的
  「工作流」标签隐藏。四处减法必须由**同一次判定**驱动，不得出现「策略说开、create 说关」的裂口。
- **R8 工具面三态**：`includeDynamicWorkflow` 只有显式 `false` 才下架工具。缺席代表调用方
  不参与灰度（CLI TUI、headless、workflow_child），必须保留全部工具面。fail-closed 的缺省值
  落在协议服务端的 `appRuntimePreferences`，不在工具注册层。本规则不因 R2 反转而改变——
  反转的是**灰度快照的缺省**，不是工具注册层的三态语义。

## 状态所有者与写入路径

- **取值域、归一化、缺省值、布尔折叠、快照形状的唯一所有者**：
  `packages/shared/src/dynamic-workflow-feature.ts`。三端只读消费，不得各自再定义模式列表
  或缺省值。
- **远端读取与优先级折叠的所有者**：
  `packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts`。
  它是唯一调用 `resolveDynamicWorkflowClientConfig` 并接触 `/api/v1/client/configs` 的地方；
  本地环境覆盖在任何网络动作**之前**裁决，命中即返回，不发请求。
- **构建档位环境改写的所有者**：`packages/desktop/src/main/desktopRuntimeEnv.ts`。
  对这个键只有「写」和「删」两种动作。
- **进程内单次判定的所有者**：`packages/services/src/acode-agent/acodeAgentService.ts` 的
  `resolveDynamicWorkflowGate`。一个 Host 进程判定一次并固定，同时喂给
  `workspace/updateDynamicWorkflowPolicy` 与 session flag，两者因此不可能分叉。
  读取失败按关闭处理且**不再重试**（避免离线时每条 create 都赔上一次请求超时）；
  服务端翻转灰度按设计在下一个 Host 进程生效。
- **工具面注册的所有者**：`apps/acode-cli/packages/core/src/tool/handlers/index.ts`
  （`DYNAMIC_WORKFLOW_TOOL_NAMES` + `includeDynamicWorkflow` 三态门）。
- **UI 可见性的所有者**：`packages/ui/src/store/dynamicWorkflowAvailabilityStore.ts`，
  经 `useDynamicWorkflowAvailability` 只读暴露；取数由 Root 里的 loader 唯一负责。
  一个 app 会话只取一次，loading 期间恒为不可用。

## 接口

```ts
export const DYNAMIC_WORKFLOW_MODES = ["disabled", "onDemand", "alwaysOn"] as const;
export type DynamicWorkflowMode = (typeof DYNAMIC_WORKFLOW_MODES)[number];
export const ACODE_DYNAMIC_WORKFLOW_MODE_ENV = "ACODE_DYNAMIC_WORKFLOW_MODE";
export const DEFAULT_DYNAMIC_WORKFLOW_MODE: DynamicWorkflowMode = "alwaysOn";

export function normalizeDynamicWorkflowMode(value: unknown): DynamicWorkflowMode | undefined;
export function isDynamicWorkflowModeEnabled(mode: DynamicWorkflowMode): boolean;

export type DynamicWorkflowClientConfigSource = "remote" | "override" | "default";
export interface DynamicWorkflowClientConfig {
  readonly mode: DynamicWorkflowMode;
  readonly enabled: boolean;
  readonly source: DynamicWorkflowClientConfigSource;
}
export function createDynamicWorkflowClientConfig(
  mode: DynamicWorkflowMode,
  source: DynamicWorkflowClientConfigSource,
): DynamicWorkflowClientConfig;

export function resolveDynamicWorkflowClientConfig(input: {
  remote: unknown;
  env?: Record<string, string | undefined>;
}): DynamicWorkflowClientConfig;
```

`resolveDynamicWorkflowClientConfig` 是纯函数：不发请求、不读 `process.env`（由调用方注入），
因此三端可以在各自的 owner 里调用它而不会产生第二份优先级实现。

## 事件顺序

1. Desktop main 在 fork Host **之前**按构建档位决定 `ACODE_DYNAMIC_WORKFLOW_MODE`：
   先无条件删除继承值，再按档位 spread 回决策结果（三层里有两层不写这个键，
   少了先删这一步，production 包和 dev 的非法取值都会原样穿透到 Host）。
2. Host 起来后，client 就绪路径上第一次需要该判定时调用 `resolveDynamicWorkflowGate`：
   - provider 先看本地环境覆盖；合法即返回 `{mode, enabled, source: "override"}`，**不发网络请求**；
   - 否则请求 `/api/v1/client/configs`，把 `data.configs.dynamicWorkflow` 交给
     `resolveDynamicWorkflowClientConfig`；远端合法 → `source: "remote"`；
   - 远端缺席/非法/请求失败 → `DEFAULT_DYNAMIC_WORKFLOW_MODE`，`source: "default"`。
3. 判定结果被 memoize 在本进程，随后**同源**分发给两条通道：
   `workspace/updateDynamicWorkflowPolicy`（驱动 UI 可见性与命令目录）与
   `createSession` / `session/create` 的 `dynamicWorkflowEnabled` flag（驱动工具面）。
4. 判定为假时，`enabled: false` 一路传到 `registerBuiltInTools` 的
   `includeDynamicWorkflow`，十个工具下架；技能剔除与 `/workflow` 过滤同时发生（R7）。

## 验收场景

1. **远端什么都没说 → 可用。** `resolveDynamicWorkflowClientConfig({remote: undefined, env: {}})`
   返回 `{mode: "alwaysOn", enabled: true, source: "default"}`。
2. **远端下发非法值 → 可用（落缺省）。** `remote: {mode: "nonsense"}` 与 `remote: {mode: 42}`
   与 `remote: "alwaysOn"`（形状不对，不是对象）都返回 `source: "default"`、`enabled: true`。
3. **远端显式关闭 → 不可用（远端否决权，R4）。** `remote: {mode: "disabled"}` 且无环境覆盖时
   返回 `{mode: "disabled", enabled: false, source: "remote"}`。
4. **环境覆盖压过远端（R3）。** `env: {ACODE_DYNAMIC_WORKFLOW_MODE: "disabled"}` 且
   `remote: {mode: "alwaysOn"}` → `{mode: "disabled", enabled: false, source: "override"}`。
   反向同理：环境 `alwaysOn` + 远端 `disabled` → `enabled: true, source: "override"`。
5. **非法环境覆盖不参与裁决。** `env: {ACODE_DYNAMIC_WORKFLOW_MODE: "  "}` 或 `"nope"`
   时，继续看远端；远端也没有则落缺省，`source` 必须是 `"default"` 而不是 `"override"`。
6. **`onDemand` 折叠为可用（R5）。** 远端 `{mode: "onDemand"}` → `enabled: true`，
   `source: "remote"`，`mode` 原样保留为 `"onDemand"`（不因折叠而丢失三态信息）。
7. **Desktop 三档环境决策不因本次改动而变。** 未打包 dev 透传合法值、丢弃非法值；
   打包 preview 固定写 `alwaysOn`；打包 production 不写该键，且继承值被删除。
8. **production 档下服务端仍能关。** 打包 production（环境键缺席）+ 远端 `disabled`
   → 不可用。这是场景 3 与场景 7 的合成，也是「只改缺省值、不改 Desktop 写值」这个裁决
   存在的理由。
9. **工具面三态不受影响（R8）。** `includeDynamicWorkflow` 缺席时十个工具全部注册；
   显式 `false` 时全部下架；显式 `true` 时全部注册。
