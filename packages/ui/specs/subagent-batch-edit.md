# 子智能体批量编辑（设置页）

设置页子智能体列表的批量模型设置：一次把「模型 / 推理档位」应用到多行，
或对一个分组整体统一设置。模块代码取自迁移批次（anker-code 4 commit 合并，
本仓 `e213a14` 引入 5 文件、`0cc983f` 因零消费者剔除），本 spec 是主接线的产品规则
登记；接线恢复于 2026-10-18，随接线同步适配本仓在迁移后落地的三类约束：
`maxTurns` 全链删除（apps/acode-cli/specs/subagent-maxturns-policy.md，R1/R2
禁止再引入）、声明键批②六键 GUI 往返保真（apps/acode-cli/specs/subagent-declarative-keys.md）、
以及**速度维度剥离**——上游模块带 speed 档位控件（SubagentSpeedField + speed 目标值），
但本仓当前检出没有该能力面（`modelSelectionSchema` 的 options 是 strict
`{ reasoningLevel }`，见 packages/shared/src/model-selection.ts；Registry optionSpecs
只有 reasoningLevel，见 packages/provider/src/registry.ts；全仓无 speed-missing
运行时校验），速度维度整体剥离（SubagentSpeedField 未取回消费、相关测试与文案一并
移除），待本仓落地 speed spec 后随功能恢复。

## 产品规则

- R1 批量入口有两个，语义不同、写路径同一：
  - **分组统一设置**：分组头（已安装 / 插件分组 / 内置）的「统一设置模型」动作打开
    批量对话框，目标集 = 该分组内全部可批量行（`resolveBatchApplyTargets`），不可改选。
  - **自由批量模式**：区块头「批量编辑」进入批量模式；可批量行出现复选框，行点击=
    切换选中（不再进入编辑表单）；吸底批量操作条展示已选计数、目标值控件与应用/退出。
- R2 可批量行判定（`isBatchApplicableAgent`）与单项编辑口径同源：
  - 内置目录成员（general-purpose / Explore，经 `getBuiltInSubagentName` 白名单）→ 行内
    覆盖路径（agents-state.json，`setBuiltInModelOverride`）；
  - 插件 agent → 行内覆盖路径（`setPluginAgentModelOverride`，只写用户 state，不改插件 md）；
  - 可编辑自建/工作区 agent（`isEditableUserAgent` 同判定）→ 定义文件重写路径
    （`updateAgent`，载荷 = `buildUserAgentBatchConfig`）；
  - 只读 profile（不可编辑的自建行、bundled 预置成员）不可批量，不渲染复选框。
- R3 目标值语义与单项行内控件一致：
  - 「继承默认」（空 modelSelection）= 覆盖路径写入清除（modelSelection 缺省），
    定义文件路径移除 model/thoughtLevel 声明；
  - 目标值在控件内经 `completeNewModelSelection` 解析成 `ModelSelection` 结构体，
    调用方不做 picker 编码串手写切分（防 custom: 双重编码落盘）。
- R4 应用为逐行串行；单行失败不中断批次，失败行保留原值；结束后一次性刷新列表与
  mention store；结果在操作条展示成功/失败计数与失败行名单。
- R5 定义文件重写以行投影为基线，仅替换模型维度；其余字段（tools/skills/permissionMode/
  background/mcpServers/injectAgentsMd 与声明键批②六键 isolation/observer/observerMessage/
  observeSubagents/initialPrompt/hooks）原样透传，禁止静默丢键；`maxTurns` 不在载荷面
  （全链已删，见 maxturns-policy spec）；speed 不在载荷面（本仓无该能力面，见文件头）。
- R6 退出批量模式 / 切换作用域 / 进入编辑表单时，选中态清空；选中集始终是当前过滤
  可见 ∩ 可批量行的子集（过滤变化时裁剪）。

## 状态所有者

- `SubagentsSection` 是批量会话状态的唯一所有者：批量模式开关、选中 id 集、应用进行中、
  进度 `{done,total}`、批次结果。批量条与对话框是无状态受控组件（只暂存未确认目标值，
  不持有已确认状态）。
- 持久化所有者不变：覆盖路径归 subagentsService（agents-state.json），定义文件路径归
  subagentsService.updateAgent；UI 不新增写入通道，批量应用复用单项编辑的同一批
  service 方法。

## 接口

- `packages/ui/src/settings/SubagentModelBatchApply.ts`：纯逻辑（应用集、写路径、三态
  勾选、结果汇总、定义文件载荷构造）。
- `packages/ui/src/settings/SubagentModelBatchBar.tsx`：吸底操作条（方案 A，自由批量）。
- `packages/ui/src/settings/SubagentModelBatchDialog.tsx`：分组统一设置弹层（方案 B）。
- testids：`TID_SUBAGENT_BATCH_BAR` / `TID_SUBAGENT_BATCH_APPLY` /
  `TID_SUBAGENT_BATCH_MODEL_TRIGGER` / `TID_SUBAGENT_BATCH_DIALOG`（packages/shared/src/test-ids.ts）。

## 事件顺序

```
用户选中行（复选框/整组弹层）
  → SubagentsSection 计算 targets（resolveBatchApplyTargets ∩ 选中集 / 分组可批量集）
  → onApply(value)（value 由控件解析为 ModelSelection 结构体 + thoughtLevel + speed）
  → 逐行串行：按 resolveBatchWritePath 分流
      override       → setBuiltInModelOverride / setPluginAgentModelOverride
      definitionFile → updateAgent(buildUserAgentBatchConfig(agent, value))
  → 每行成功记 succeeded / 失败记 failed（含行名与错误消息），进度 {done,total} 推进
  → 批次结束：setBatchResult；refresh + refreshMentionStore 一次
```

## 验收场景

1. 分组头「统一设置模型」→ 弹层显示分组名与可批量行数；选模型后推理档位控件按
   Registry 投影出现；确认后该分组可批量行逐行落盘，行内覆盖控件反映新值。
2. 自由批量模式：勾选 3 行 → 操作条选目标模型与推理档位 → 应用 → 进度推进后操作条
   展示「已更新 3 个」；退出批量模式后列表与行内控件为最新值。
3. 继承默认：目标值留空（或点「恢复继承默认」）→ 覆盖行覆盖被清除，自建行定义文件
   移除 model/thoughtLevel 键，其余键保留。
4. 带失败批次：某行写入抛错 → 其余行继续；结果展示成功/失败计数与失败行名，失败行
   原值不变。
5. 只读行（不可编辑自建、bundled 预置）在批量模式下无复选框；分组内全部不可批量时
   分组头不提供统一设置入口（targetCount=0 时动作不出现）。
6. 声明键保真：含 isolation/observer 等批②键的自建 agent 被批量改模型后，定义文件
   仍携带全部批②键（SubagentModelBatchApply 单测钉住）。
7. i18n：全部批量文案 en-US / zh-CN 成对；`maxTurns` 零出现（apps/acode-cli/tests/
   subagent-maxturns-dangling.test.mjs (5) 全域扫 packages/ui/src）。

## 与单项编辑的一致性约束

- 可批量判定、写路径分流、模型结构体解析三处逻辑与单项编辑共用同一套判定函数与
  service 方法；禁止为批量另建平行写入面或第二份可批量判定。
- 批量条/弹层不感知 service：应用回调由 SubagentsSection 提供；两方案（A/B）共用
  同一回调实现。
- 刻意差异（记录理由）：批量应用不触发单项路径的 start-plan 推荐弹窗——该推荐是
  逐行交互式增值提示，批量目标值已是显式选择，逐行弹窗会打断串行应用与进度语义。
