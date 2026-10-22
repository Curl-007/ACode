# 会话标题生成启用面与可观测性（session-title-generation）

2026-10-21 用户报告「会话标题生成逻辑坏了」取证修复。现象：桌面本地会话标题永久
停留 `title_source=first_input`（首条用户消息截断原文），`time_title_updated` 等于
创建时间；日志零 `session_title_generation.failed` warn——生成器**从未被尝试**而非
失败。

## 根因

`bootstrap/src/app/runtime-config.ts` 对 `options.runtimeConfig.titleGeneration`
缺省返回 `undefined`；桌面本地 host 链路（desktop → services acodeAgentService →
strict protocol）从不显式注入该字段（仅 automation/闲时传 `titleGenerationEnabled:
false`、protocol server-operations 与 TUI 路径注入 `{}`），于是
`shouldAttemptSessionTitleGeneration` 的 `!config.titleGeneration` 静默 return false，
turn 末的 deferred 重试同条件再静默 false——全链路零日志，CI 与日志均不可见。

## 产品规则

### R1 缺省启用

`runtime-config.ts`：`titleGeneration` 缺省（undefined）= **启用**（`{timeoutMs:
60_000}`），显式 `{enabled:false}` 原样尊重（automation/闲时任务经
`titleGenerationEnabled:false` 传入，语义不变）。子会话/非交互 taskType/非首轮的
既有跳过条件不变（shouldAttempt 其余分支）。

### R2 静默跳过零留痕禁令

`shouldAttemptSessionTitleGeneration` 的每个跳过分支必须落 **debug** 日志
（`event: session_title_generation.skipped` + `reason` 闭集：disabled /
config_absent / no_session_store / child_session / non_interactive_task /
not_first_turn / empty_input / short_input / no_model_selection——最后一条在
sidecar 的模型选择早退处）。debug 级生产不落盘（AGENTS.md 日志分级），但
dev/诊断会话可取证；跳过不再是零留痕路径。

### R3 生成与回退语义不变

sidecar 模型请求、60s 入口超时、失败 warn（`session_title_generation.failed`）、
`first_input → generated` 的来源迁移、短首发输入不覆盖（short_input 跳过）等既有
语义全部不变；本 spec 只管启用面与可观测性。TITLE_SYSTEM.md 路由覆盖
（stable-prefix-pause-gate.md R5）不变。

## 验收场景

1. `runtime-config`：`titleGeneration` 缺省 → 解析结果含 `{timeoutMs:60000}`；
   `{enabled:false}` → 保留 disabled；`{}` → 补 60s 超时（既有行为不回退）。
2. `shouldAttempt` 跳过分支：config 缺省/禁用/子会话/非首轮各返回 false 且 reason
   闭合（单测或 dev 日志取证）。
3. 实机：桌面新建交互会话首轮结束后标题由 first_input 迁移为 generated
   （`title_source=generated`，`time_title_updated` 晚于创建时间）。

## 验证命令

```bash
node apps/acode-cli/node_modules/typescript/bin/tsc -p apps/acode-cli/packages/bootstrap/tsconfig.json --noEmit
node apps/acode-cli/node_modules/typescript/bin/tsc -p apps/acode-cli/packages/core/tsconfig.json --noEmit
node --import tsx --test apps/acode-cli/packages/core/tests/session-title-skip-reasons.test.ts
```
