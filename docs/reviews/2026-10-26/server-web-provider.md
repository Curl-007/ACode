# ACode 1.0.4 深度 Review · server / web / provider / model-option-map / server-cli

审查日期：2026-10-26（Asia/Shanghai）。基线：`dev/1.0.4`，提交 `6b2bc3fc`。方法：只读源码审查 + 上轮（2026-10-22，基线 `ebe9033b`）修复逐条核验 + 重连状态机逐路径推演。总入口见 [../../project-review-2026-10-26.md](../../project-review-2026-10-26.md)。

范围：`packages/server/**`、`packages/web/**`、`packages/provider/**`、`packages/provider-node/**`、`packages/model-option-map/**`、`packages/acode-server-cli/**`、`packages/client/**`。

---

## 1. 上轮修复回归核对

| finding | 声称修复 | 核验结论 | 当前证据（file:line） |
|---|---|---|---|
| **R2-04 [P2]** connect-remote 原始 `err.message` 泄漏 | 归类 → `remote-connect-failed`，原始 → warn | **HOLDS** | `server/src/http.ts:626-628`（detail→warn `:627`；响应体 = 静态码） |
| 无其他端点泄漏原始 err.message | — | **HOLDS** | 全部 `c.json({error})` 为静态/归类；仅有的内插是 `${provider}`（白名单 `:633-635`）、`${trust.reason}`/`${binding.reason}`（枚举）。无 `Error.message` 进响应体 |
| decodeURIComponent URIError → 500 | try/catch → null → 404 | **HOLDS** | `http.ts:370-374` |
| 待认领连接 TTL | 惰性过期 60s、纯函数、2 prune 触点 + 认领校验、无常驻定时器 | **HOLDS** | `http.ts:195-222`（纯 `isPendingConnectionExpired`/`pruneExpiredPendingConnections`）；prune `:601`+`:711`；认领复检 `:719`→4004 |
| getActiveProvider 无检查强转 | 过 `isWebOAuthProviderId` | **HOLDS** | `web/src/auth/browserOAuthCredentialRepo.ts:114` |
| server zod devDependency | type-only import；运行时内联 | **HOLDS** | `package.json:58`；仅 `import type {z}`（`harness/translate.ts:24`）；zod 不在 `SERVER_HTTP_EXTERNAL_DEPENDENCIES`（`tsup.config.ts:30-49`），经 `@acode/shared` noExternal 内联到达——依据扎实 |
| **R2-05 [P2]** Web WS 断线死界面 | 指数退避重连 + overlay + pagehide 清理；`web/src/reconnect/`；spec R1-R6 + 7 验收；web 首个 test 脚本 + 14 测 | **HOLDS（主路径）/ 但新模块带 2 个生命周期缺陷（见 §2，均 P2）** | `main.tsx:220-263` + `reconnect/webSocketReconnect.ts`；spec `web/specs/web-reconnect.md`；`webSocketReconnect.test.ts` 假 timer/connect 驱动完整状态机 |
| model-option-map 有界缓存 | `bounded-cache.ts` LRU 512 替换 3 个裸 Map | **HOLDS** | `bounded-cache.ts:21-51`（插入序 LRU，get 时 delete+reinsert，溢出驱逐最旧）；`compiler.ts:26-28` 接线，`:36/44/54/68/82/85` get/set；compiler 内**零**裸 `new Map()` 残留 |
| provider-node / server-cli 覆盖 ≥0.15 | 各 +3 测试文件 | **HOLDS（超出）** | provider-node **4** 文件/21 源 = 0.19；server-cli **7** 文件/45 源 = 0.156 |
| server 鉴权不变量 | assert / Origin 前置于 mint / consume() 实查 | **HOLDS** | `assertServerAuthInvariant` `http.ts:768`（`shared/src/node/serverAuth.ts:59-66` 非 loopback 无 token throw）；Origin 门 `:490-497` 严格先于 `issue()` `:498`；`consume()` 结果实查 `:561-563` + 绑定强制 `:567-574` |
| 新测试真实性 | 非字符串匹配 | **HOLDS** | web 假 timer 驱动全状态机；mom 测真实 fail-closed 分支（除零→Infinity throw、`__proto__` 不污染 `:72-78`、缓存守护 throw `:200-202`）；server-auth 40+ 行为用例含负向注入 |

**webPlatform.ts 拆分保持重连完整（主审亲验）**：`webPlatform.ts` 是纯 `IPlatformService` 工厂（逐字抽取）；重连逻辑全在 `main.tsx:220-263` + `reconnect/`，未被拆分触碰。`main.tsx` = **266 行**（400 门下，豁免头注已移除）。

## 2. 新发现（两个 P2，均在 1.0.4 全新的重连模块内——主审逐行亲验）

### [P2] bfcache `pagehide` 永久禁用重连 → 手机主用例死界面（R2-05 症状复发）

- **位置**：`main.tsx:263` + `webSocketReconnect.ts:160,166-170`
- **机制（CONFIRMED，主审逐行核验）**：`window.addEventListener("pagehide", () => controller?.cancel(), { once: true })`。`pagehide` 不只在真卸载时触发，也在 **bfcache 进入**（往返缓存）时触发——这是手机 Safari/Chrome 的主导后台机制，而 AGENTS.md 明记手机远控（`web-remote-replayable`）是本链路的首要目标。`cancel()` **终态**置 `cancelled=true`（`:167`），此后 `start()` 永久 no-op（`if (cancelled || looping) return`，`:160`）。**无 `pageshow`/`persisted` 重新武装**（grep 确认 `packages/web/src` 仅此一个 pagehide 监听），且 `{once:true}` 移除监听器。
- **后果**：手机切后台→回前台的 bfcache 往返后，若 socket 在后台被回收（手机上常态），`onClose → controller?.start()` 什么都不做：不重连、不显示 overlay——**正是 R2-05 的死界面症状，在最常见手机场景复发**。当前修复覆盖「前台时 server 重启」，不覆盖「手机睡眠、用户返回」。
- **修复入口**：`pagehide` 处理器检查 `event.persisted`（true = bfcache，不 cancel；仅真卸载才 cancel），或配对 `pageshow` 监听在 `persisted` 时重建 controller 并 `start()`。spec `web-reconnect.md` 需补 bfcache 验收场景。

### [P2] `retryNow()` 在 connect 进行中触发 → 孤儿活 socket 泄漏；孤儿 `onClose` 事后驱动当前 controller

- **位置**：`main.tsx:227,253-257` + `webSocketReconnect.ts:141-143`
- **可达性（主审亲验）**：overlay 在 `connecting` 阶段也渲染（`onStateChange` 对除 `reconnected` 外所有状态渲染 overlay，`main.tsx:244-248`），带活的「重新连接」按钮——用户**可以**在一次 `connect()` 进行中点 `retryNow()`。
- **机制**：`retryNow` 做 `controller?.cancel(); controller = makeController(); controller.start()`（`:253-256`）——新 controller 对旧 controller 的 pending `connect()` 一无所知。两个后果：
  1. **socket 泄漏（必然）**：被孤儿化的 `connect()` resolve 时命中 `if (cancelled) return`（`webSocketReconnect.ts:141-143`），**丢弃已 resolve 的 `WebServices` 且无任何处置**——而且根本没有处置路径：`IServiceAccessor`/`RemoteServiceAccess` **不暴露** `dispose`/`close`（主审 grep `remoteServiceAccess.ts`/`accessor.ts` 零命中）。打开的 WebSocket + ChannelClient 泄漏。
  2. **健康会话上假性重连（时序依赖）**：每次 `establish()` 注册 `onClose: () => controller?.start()`，闭包引用**同一个可变** `let controller`（`:223,227`）。孤儿 socket 最终关闭时，其 `onClose` 对**当前**（已重连、idle）controller 调 `start()` → 通过守卫 → 发 `waiting` → 在正常工作的会话上渲染断线 overlay + 再开一个 socket + 重挂 `Root`。
- （次要：`?remote=<id>` bootstrap 下第二个 socket 会与一次性 claim 竞速、败者得 4004——该路径已在 `webPlatform.ts:30-32` 记载为不支持，作次要注记。）
- **修复入口**：① `retryNow` 仅在非 `connecting` 阶段可用（overlay 按钮在 connecting 态禁用），或 ② controller 换代时把旧 controller 的 pending connect 结果导向显式处置（需先给 accessor 补 `dispose`），且 `onClose` 闭包捕获**所属代**的 controller 而非可变外层引用（代际 token 比对）。

## 3. 重连正确性深检（主路径全部 ✔）

- **退避**：`base·2^(attempt-1)` → `Math.min(_, maxDelayMs)` → `·random()`。指数、封顶、溢出安全（`2^49→Infinity`，min→cap；测试在 attempt=50 验证）。✔
- **抖动**：full jitter `capped·random[0,1)`——正确的惊群缓解；边界已测（0/0.5/0.999）。✔
- **上限**：`maxDelayMs=15000`、`maxAttempts=Infinity`（持续但有界，spec R1.4）。✔
- **cancel 清理**：清挂起 timer + 终态标志；测试断言 `pendingCount()===0`、`fireAll()` 后零 connect。✔——但**终态性正是 bfcache 缺陷的根源**。
- **双连接守卫**：`start()` 经 `looping` 幂等（已测）。✔ **缺口**：幂等是 *per-controller* 的；`retryNow` 在 connect 进行中换代 controller，守卫不跨越换代——即孤儿缺陷。
- **正常成功路径**：单一活 socket（重连由旧 socket 的 close 触发，无重叠）。✔

diff 中无新错误消息泄漏、无 TTL 旁路、无无界缓存。层内其余模块级 Map 均为 per-call 局部或有界/重建型注册表（provider registry 整体重建，非追加）。

## 4. 层面健康度

**良**。上轮全部 finding 真修且有真行为测试背书；server 鉴权 fail-closed 链端到端保持；有界缓存/惰性 TTL/错误归类干净。不到优的唯一原因：**全新重连模块带着两个生命周期边界缺陷出货**（终态 `pagehide` cancel 无 bfcache 重武装；无守卫的 `retryNow`-during-connect）——在手机常见场景复发 R2-05 死界面症状并泄漏 socket。两者都是「修复引入的新缺陷」类：主路径正确且测试扎实，但边界生命周期（bfcache、换代竞态）不在测试矩阵内。建议给 `web-reconnect.md` 补两条验收场景 + 对应假 timer/bfcache 事件测试，再按 §2 修复入口落地。
