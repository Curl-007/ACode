# host/index.ts 领域拆分地图

状态：第一批已实施（2026-10-05，深度审查 P2）；其余域为登记在案的后续批次。
背景：host/index.ts 曾以 2,937 行混合 8-10 个可独立演进的领域（深度审查发现 #6）。
第一批抽出 automation 派发域（约 711 行）后为 2,204 行。

## 已抽出（第一批，2026-10-05）

| 模块 | 领域 | 行数 |
| --- | --- | --- |
| `automationDispatchContext.ts` | 派发域共享上下文契约（logger/惰性 services/registry getter） | 40 |
| `cronRunDispatch.ts` | cron/manual automation 派发 + 目标 services 解析 | 283 |
| `cronRunTracking.ts` | run 台账、订阅追踪、heartbeat 通知决策接线 | 223 |
| `offPeakRunDispatch.ts` | 闲时任务派发 + off-peak 运行时装配 + 终态回填 | 377 |

约束（后续批次同样适用）：入口文件与派发域之间只经上下文接口传递依赖；创建位置晚于工厂调用的模块级状态（activeServices、windowRemoteConnectionRegistry）必须以惰性 getter 传递，不得构造期求值；抽出为纯机械迁移（逐字搬运 + 依赖替换），守护测试扫描目标随实现迁移（先例：`tests/automation-heartbeat-protocol.test.mjs`）。

## 待抽出的剩余域（按独立性排序）

| 域 | 现位置（约） | 备注 |
| --- | --- | --- |
| 反馈日志归档 | :190-345 | pendingFeedbackLogArchiveRequests + createFullFeedbackLogArchiveViaMain + 本地媒体预览授权；依赖 parentPort 消息面 |
| agent 预热 | warmUpACodeAgent | 纯函数形态，最易抽 |
| 远程 task service 包装 | createReportingRemoteACodeTaskService（约 330 行） | 依赖 workspaceTaskTracker/workspaceProxyState/runtimeTaskReporter，需以参数显式传入 |
| remote connection handle + controller 路由 Proxy + MessagePort 服务暴露 + attachment registry | :1643-2090 一带 | 与 shutdown 收口耦合最深，最后抽 |

每批完成后：`tsc -b tsconfig.host.json` 全绿 + `packages/desktop` 测试套件全绿 + 超限文件 ratchet 基线收紧（`pnpm architecture:baseline:update`，仅当计数下降）。
