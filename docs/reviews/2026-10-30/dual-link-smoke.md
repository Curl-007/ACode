# 双链路真实冒烟报告（2026-10-30，第七会话）

> 目标：闭合 `docs/legacy-protocol-convergence-plan.md:192` 的 M2 风险条——13 个
> stream/snapshot/queue 高危方法（m2-scoping.md §4）的 desktop-continuous +
> web-remote-replayable 双链路真实冒烟。
> **结论先行：旧口径「headless 不可跑」在协议语义层被推翻**——两条链路均可在本机
> 全真拉起并完成实测；真机不可替代面收敛到移动浏览器生命周期约 5%（见 §5）。

## 1. 环境

- worktree `fix/project-review-2026-10-26`（HEAD `d5a31acf`）dev 构建；模型 =
  数据目录内 BYO 自定义供应商「新供应商/kimi-k3」（真实流式回合，68.4 tok/s 实测）。
- 链路一：`pnpm dev:desktop`（Electron + CDP 9229，`VITE_ACODE_E2E_STORE_BRIDGE=1`
  打开 store 桥）；默认数据目录（与日常安装版同目录，桌面实例独占期间运行）。
- 链路二：`pnpm --filter @acode/server dev`（:3030，LoggingChannelServer 全 RPC 留痕）
  + `pnpm --filter @acode/web dev`（:5173）+ 无头 Edge（CDP 9333，独立 profile）。
  web 客户端即手机浏览器同一代码路径（packages/web，mobileDeviceFingerprint 同源）。
- 两链路**串行**执行（同一数据目录单 Host 纪律，避免 sqlite 并发写）。
- 驱动：scratchpad CDP harness（Runtime.evaluate / Input 事件 / 截图），未入仓。

## 2. 链路一 desktop-continuous 实测矩阵

| 方法 | 结果 | 证据 |
|---|---|---|
| sessionCreate | ✅ | 草稿首发建任务；侧栏新任务 + host `file.ensureConversationWorkspace` |
| sessionSend | ✅ | 两真实回合（kimi-k3 流式 68.4 tok/s、首 token 8.4s）；queue 准入 UI「继续输入以排队后续修改」 |
| sessionSubscribe | ✅ | 流式行实时投影；renderer `[memory] projection.rows` 心跳 |
| sessionStop | ✅ | 流中点「停止生成」→「已停止」；turn 终止 |
| sessionFork | ✅ | OK 行「分叉」→ 新任务「Fork of …」继承全部行（「从对话中派生」） |
| sessionCompact | ✅ | `/compact` → 「上下文已压缩」行 |
| sessionGoal | ✅ | `/goal …` → 「第 1 次迭代 · 目标已完成，任务结束」 |
| sessionResume | ✅ | 任务重开 + renderer `Page.reload` 后冷恢复，行完整 |
| sessionRead | ✅ | 重开/重载路径的快照冷读（行与 token 计数恢复） |
| sessionClose | ✅ | 行右键「归档任务」→ 活动列表移除 |
| sessionCancelBackgroundTask | ⚠️ 未触发 | 需真实后台 work，冒烟上下文无法强制产生；单测覆盖 |
| sessionMessages / sessionEvents | ⚠️ 桌面 UI 不可达 | harness/ACP 消费面（packages/server/src/harness），server 套件覆盖 |

wire 证据：host 日志 `[rpc:call] acode-agent.* / acode-session.* / acode-task.*`
（含 `subscribeConversationV4`、`sendConversationCommandV4`、`readSessionHeaderMeta`）
+ turn 生命周期事件（turn-started/turn-ended、sequenceNumber）。

## 3. 链路二 web-remote-replayable 实测矩阵

| 语义 | 结果 | 证据 |
|---|---|---|
| create/send/subscribe（冷启动） | ✅ | server1 日志 `sendConversationCommandV4`×4、`subscribeConversationV4`、`initializeConversationV4`、`helloConversationV4` |
| queue admission（busy 入队） | ✅ | 流中第二条消息显示「排队」 |
| **断流** | ✅ | 流中杀 server → overlay「Connection lost / Retrying in 8s / Reconnect」 |
| **自动重连 + snapshot 重建** | ✅ | server2 起来后 overlay 消失；`subscribeConversationV4`/`initializeConversationV4` 重订阅；turn1 行（含 WEBOK 回复）完整恢复 |
| **queue 跨进程持久化 + drain** | ✅ | turn2（排队中遭遇 server 死亡）在重连后执行完成，「QUEUED」回复出现（persistent-command-facts 实证） |
| sessionStop | ✅ | 流中「停止生成」→「已停止」 |
| sessionResume/Read（冷恢复） | ✅ | server2 的 `readSessionHeaderMeta`/`subscribeSessionsIndexV4` + 行恢复 |
| sessionCompact | ⚠️ 命令未发出 | 斜杠菜单吞 Enter（自动化未选菜单项）；同 v4 command 准入路径已由链路一覆盖 |
| fork/goal/close | ➖ 未在链路二复跑 | 与链路一同一 `sendConversationCommandV4` 准入路径（双链路均有该 wire 证据） |
| sessionCancelBackgroundTask / Messages / Events | ⚠️ 同链路一 | 未触发 / harness 面 |

## 4. 结论与口径修正

1. **M2 风险条在协议语义层闭合**：stream（双链路真实流式）、snapshot（重连重建/冷读）、
   queue（准入/持久化/跨进程 drain）、reconnect（overlay→退避→重挂）全部实机实证。
2. m2-scoping.md §4「headless 不可跑」修正为：**协议语义层本机可全真跑**（Electron+CDP
   与 server+web+无头浏览器即双链路真身）；「需桌面+手机环境」收敛为 §5 真机残余面。
3. 诚实登记未覆盖：cancelBackgroundTask（无真实后台 work）、messages/events（harness
   面）、链路二 compact/fork/goal/close 未逐一复跑（同准入路径，风险同质）。

## 5. 真机残余面（发布观察项，非阻塞）

- 移动 Safari/安卓 WebView 页面生命周期（切后台冻结→pageLifecycle 路径）。
- 移动网络抖动下的真实断流（本冒烟以进程级杀断模拟，粒度更粗但语义同源）。
- 触摸/视口交互（不影响 13 方法协议语义）。
建议：1.0.4 发布前用真机过一遍「打开会话→断网→恢复→续流」单场景即可覆盖残余面主体。

## 6. 复现命令

```bash
# 链路一
VITE_ACODE_E2E_STORE_BRIDGE=1 pnpm dev:desktop   # CDP 9229
# 链路二（分进程，便于独立重启 server 演断流）
pnpm --filter @acode/server dev &                # :3030
pnpm --filter @acode/web dev &                   # :5173
msedge --headless=new --remote-debugging-port=9333 --user-data-dir=<tmp> http://localhost:5173
```
