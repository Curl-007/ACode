# 内建输出风格注册表与按名选择（W7 第一阶段）

提示词优化批次（2026-10-03）P1 项。输出风格的**机制**已完整存在
（`OutputStylePromptConfig { name, prompt, keepCodingInstructions? }` →
identity 开头行切换 + `# Output Style` system 段 + 每请求 reminder，
消费链见 `context/sections/identity.ts:32-43`、`dynamic-sections.ts:252-261`、
`runtime-reminders.ts:270-277`、`runtime/methods/config.ts:66-70`），
但**没有任何内建风格与产品选择面**：全仓 grep 无一处产品代码设置
`outputStyle`（bootstrap/CLI/TUI/UI/协议 0 命中），插件 manifest 的
`outputStyles` 字段在 `UNSUPPORTED_MANIFEST_FIELDS`（诊断-only）。

本 spec 只落第一阶段：**core 内建风格注册表 + 按名解析**，让风格成为
first-class 文本资产并可被任何后续选择面按名接通。协议字段、UI 选择器、
CLI flag、插件 manifest 转正需要一条「选择面 → runtime config patch」的
投递链，属跨包产品特性，结转后续 owner（见「不在本项范围」的投递链清单）。

## 背景（已核实的现状）

- `updateConfig` 的 patch 类型是三处重复的内联
  `Pick<AgentRuntimeConfig, "mode" | "planEnabled" | "language" | "outputStyle">`
  （`runtime/methods/config.ts:51`、`runtime/internal-methods.ts:69-71`、
  `runtime/agent-runtime.ts:342-344`）；`outputStyle` 只收对象。
- `"outputStyle" in patch` + 显式 `undefined` = 清除风格（既有语义，保留）。
- 风格激活时 identity 段开头行切换为「按 Output Style 响应」措辞——该段是
  system-stable + persistable（manifest 在册）；内建风格文本经 config 注入后
  属于**运行期数据**，与 manifest 的关系维持现状（manifest 只 hash 无风格缺省态，
  风格文本自身不进 manifest——它不是段 descriptor 的产出，是 config 值）。

## 产品规则

### R1 内建注册表（唯一所有者：`core/src/context/output-styles.ts`，新文件）

首批两个风格（英文自撰，`prompt-language-policy.md` R1/R7）：

| name | 定位 | keepCodingInstructions |
| --- | --- | --- |
| `explanatory` | 教学式：任务步骤之后附简短洞察，把具体改动连到一般模式（为什么成立、代价、何时换模式）；代码/答案先行，解释随后不替代；分量与新颖度成比例，不解释用户显然已知的内容 | `true` |
| `concise` | 精简式：直接作答，无开场白/复述/收尾总结；用承载答案的最短完整句，代码能答就用代码；省客套与填充词；**承重信息不许省**（风险、代价、用户必须 follow 的步骤） | `true` |

- 每个风格 prompt ≤ 800 字符（风格段进每请求 system 前缀，token 成本常驻）。
- `name` 全小写、唯一；注册表为 `readonly` 数组 + 按名索引的解析函数。
- learning/mentor 风格（让用户亲手写关键代码 + TODO(human) 协议形态）判为
  交互重、需要选择面与 UI 配合，不进首批，登记为候选。

### R2 按名解析（`resolveOutputStyleSelection`）

```ts
resolveOutputStyleSelection(
  selection: string | OutputStylePromptConfig | undefined,
): OutputStylePromptConfig | undefined
```

- `string`：按名查内建注册表，**大小写不敏感**；命中 → 该风格的 config 对象；
  未命中 → `undefined` 且调用方**不改写现有风格**并记一条 warn
  （诊断开关同款哲学：拼错名字不该静默清掉用户的风格）。
- 对象：原样透传（自定义风格的既有通道不变）。
- `undefined`：透传 `undefined`（保持「显式 undefined = 清除」的既有语义——
  清除与未命中的区分在调用方：`in patch` + 解析结果为 undefined + 输入本来就是
  undefined 才是清除；输入是未命中字符串则不动）。

### R3 patch 类型收敛 + 接线

- `runtime/types.ts` 新增命名类型 `RuntimeConfigUpdatePatch`（= 既有 Pick 组合
  Omit 掉 outputStyle 后并入 `outputStyle?: OutputStylePromptConfig | string`），
  三处声明（config.ts / internal-methods.ts / agent-runtime.ts）统一改用它——
  消除三份内联 Pick 的漂移面，语义不变（对象形态调用方零改动）。
- `runtime/methods/config.ts` 的 `"outputStyle" in patch` 分支内先过
  `resolveOutputStyleSelection`：字符串未命中 → warn + 跳过赋值（也不触发
  rebuildContextPrefix）；其余路径行为与现状逐字一致。
- `AgentRuntimeConfig.outputStyle` 的存储类型**不变**（仍是解析后的对象）——
  注册表解析发生在 patch 入口单点，运行期消费方（identity/段/reminder）零改动。

### R4 文本纪律

风格 prompt 是模型面文本：英文、自撰、无 CJK；描述**沟通形态**而不复述
编码纪律（`keepCodingInstructions: true` 的既有语义：风格不替换核心行为文本，
identity 开头行切换已是它的全部 system 面存在感）。

## 状态所有者

```
core/src/context/output-styles.ts        内建风格文本与名称→config 解析（唯一所有者）
   ▲
runtime/methods/config.ts updateConfig   patch 入口单点解析（字符串→对象；未命中 warn+不动）
   ▲
runtime/types.ts RuntimeConfigUpdatePatch  patch 类型（三处声明共用）
   │
AgentRuntimeConfig.outputStyle           存储解析后对象（类型不变）
   ├─► context/sections/identity.ts       开头行切换（不改）
   ├─► context/dynamic-sections.ts        # Output Style 段（不改）
   └─► runtime/helpers/runtime-reminders.ts 每请求 reminder（不改）
```

## 接口

- `core/src/context/output-styles.ts`（新）：
  ```ts
  export interface BuiltInOutputStyle { readonly name: string; readonly prompt: string; readonly keepCodingInstructions: boolean }
  export const BUILT_IN_OUTPUT_STYLES: readonly BuiltInOutputStyle[];
  export function resolveOutputStyleSelection(
    selection: string | OutputStylePromptConfig | undefined,
  ): OutputStylePromptConfig | undefined;
  export function isBuiltInOutputStyleName(name: string): boolean;
  ```
- `runtime/types.ts`：`RuntimeConfigUpdatePatch`（R3）。
- `runtime/methods/config.ts` / `internal-methods.ts` / `agent-runtime.ts`：
  `updateConfig` 签名改用 `RuntimeConfigUpdatePatch`；实现内加解析单点。
- 无新增环境变量；无协议/schema 变更（`packages/shared`、contracts 插件面零改动）。

## 验收场景

1. **注册表形态**：两个风格；name 全小写且唯一；prompt 非空、≤800 字符、无 CJK；
   `keepCodingInstructions === true`。
2. **解析语义**：`"concise"` → 对应 config 对象（name/prompt 逐字段一致）；
   `"Concise"`/`"CONCISE"` → 同上（大小写不敏感）；未知名 → `undefined`；
   对象 → 同一对象引用透传；`undefined` → `undefined`。
3. **patch 入口行为**（源码级钉住 + 单元级）：config.ts 的 outputStyle 分支含
   `resolveOutputStyleSelection` 调用；字符串未命中路径不赋值、不 rebuild、有 warn；
   显式 `undefined` 清除语义保留（`"outputStyle" in patch` 判定不动）。
4. **三处签名同源**：config.ts / internal-methods.ts / agent-runtime.ts 的
   updateConfig patch 类型都是 `RuntimeConfigUpdatePatch`（源码级断言，防再分叉）。
5. **消费链零改动回归**：设置风格后 identity 开头行、`# Output Style` 段、
   output_style reminder 行为与改动前一致（既有 `prompt-language-policy` /
   `system-prompt-section-registry` 测试全绿即证）。
6. **验证命令**（仓库根执行，如实记录）：`pnpm typecheck`、`pnpm lint`、
   `pnpm architecture:check -- --changed`、
   `node --import tsx --test apps/acode-cli/tests/*.test.mjs`。

## 不在本项范围（结转后续 owner 的投递链清单）

产品选择面需要一条完整投递链，任何一环单独做都是死代码，故整体结转：

1. **协议面**：`packages/shared` updateConfig 参数 schema 增 `outputStyle`
   （字符串名或对象）+ bootstrap 透传到 runtime patch。
2. **UI 面**：风格选择器（desktop/web，遵守 DESIGN.md 与 i18n 双 locale 同批）+
   Zustand 状态与广播回环防护（根 AGENTS.md UI 边界）。
3. **CLI/TUI 面**：`--output-style` 启动参数或 `/style` 命令 + i18n 文案。
4. **插件 manifest `outputStyles` 转正**：contracts 字段类型化（现为 `unknown`）+
   marketplace 加载校验 + 插件风格进注册表的命名空间规则（`plugin:style` 形态）
   ——依赖 1-3 任一选择面先存在。
5. **learning 风格**：R1 登记的候选，依赖选择面 + TODO(human) 交互协议设计。

以上每环落地时按本 spec R2 的解析入口接入，不得另建第二个名称→config 解析点。
