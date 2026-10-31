# 日志隐私脱敏：服务层 serviceLogger 漏斗（services）

核心机制见 `packages/shared/specs/log-privacy-redaction.md`；
桌面漏斗见 `packages/desktop/specs/log-privacy-redaction.md`。

## 产品规则

- R1 `createServiceLogger` 的 `write()` 是服务层日志的**唯一漏斗**
  （86+ 调用点全部经过），脱敏挂在此处，禁止在各 service 调用点散挂。
- R2 漏斗内对 args 做源头脱敏：字符串 → `redactLine`；`Error` →
  以 `message + stack` 合成字符串后 `redactLine`；其他对象**原样透传**
  （不改变日志形状，按引用交给 sink）。对象在终局字符串化漏斗（桌面 main
  `write()` / host `reportHostLog`）JSON 化后再脱敏，双层串联依赖脱敏幂等
  不变量（shared spec「状态所有者」节）。
  - R2-04 边界（review 2026-10-22 security §2 第三条）：对象源头透传意味着
    **非桌面进程**（CLI/server 默认裸 `console` sink，无终局漏斗）的对象内容
    不在本层脱敏。当前所有调用点被记录的对象只含非敏感字段，无实际泄漏。
    曾评估改为源头 `JSON.stringify` + 脱敏，但会破坏 acode-agent session start
    timing 观测面（spec R3）——该面经 console 拦截读取对象的 `workspaceKey`
    结构化字段做身份归属断言，源头字符串化+路径脱敏会让断言无法成立。故维持
    对象透传契约；守护测试钉住「对象按引用透传、字符串/Error 源头脱敏」，
    任何改动此契约的行为都必须先更新本 spec 并复核 R3 观测面。
- R3 身份来源：本进程 env 派生（os.homedir/os.userInfo +
  HOME/USERPROFILE/USERNAME/USER/LOGNAME/COMPUTERNAME/USERDOMAIN），
  懒初始化单例；Windows 注册表真名是桌面 main 的增强（desktop spec R4-R5），
  服务层不重复实现注册表访问——桌面场景下 host 日志终局仍过 main 漏斗，
  注册表真名在那里兜底。
- R4 主机名注册表：服务层单例注册表收 env 派生用户名/机器名；
  运行期远端主机名收名接线（SSH/远程 workspace 连接点）与桌面共享同一
  接线需求，不在本模块内散挂。
- R5 fail-closed：脱敏管线异常 → 该参数 `<withheld>`；身份构建异常 →
  退回无身份最小管线，日志功能不受影响。
- R6 sink 注入语义不变：脱敏发生在 sink 之前，自定义 sink（测试、转发）
  收到的已是脱敏后文本。
- R7 **traceId 槽与前缀同经脱敏**（结构性封堵，review 2026-10-26 §2 R2-04）：
  `write()` 把 `traceId` 拼进 `[trace:…]` 前缀前，必须先过 `redactServiceLogArg`
  （字符串路径），使**前缀与 args 同经唯一漏斗**。
  - 根因：`ServiceLogger` 首参类型是 `TraceId = string`，调用方误把消息串传进
    该槽（`log.info("some message", {ctx})`）时，消息落进 `[trace:…]` 前缀而非
    日志正文。此前只有 `...args` 过 `redactServiceLogArg`，**前缀（内插 traceId）
    整体绕过漏斗**——漏斗「单一脱敏点」不变量不覆盖前缀槽，在 OAuth 凭据面文件
    （`oauth/oauthService.ts`）里削弱 R2-03 建立的保证。当前 31 处误用消息均为
    静态字面量或非秘密 ID（如 `task=${offPeakTaskId}`），**无活体泄漏**，但漏洞
    是结构性的。结构性封堵后，即使槽位被误用也无法直出未脱敏内容。
  - 幂等依赖：前缀与 args 命中同一 redactor 单例，多次串联仍依赖脱敏幂等不变量
    （R2、验收场景 5）。`redactServiceLogArg` 对字符串是纯函数式 `redactLine`，
    成本低，可进热路径（每条日志一次）。
- R8 **traceId 槽误用守护**（正确形态 = `log.info(undefined, "msg", ctx)`）：
  正确调用形态是 traceId 槽传 `undefined`（或真实 traceId），消息串作为首个正文
  arg；对象上下文作为后续 arg（按 R2 契约经 args 脱敏 / 终局漏斗）。守护测试：
  - 源扫描 `packages/services/src`，断言无 `ServiceLogger`-typed logger 的
    `.info(`/`.warn(`/`.error(`/`.debug(` 以**字面量字符串作首参**的调用残留
    （allowlist 豁免 message-first 接口的 logger：`AgentSparePoolLogger`
    `acodeAgentSparePrewarm.ts`、`TrackerLogger` `cuaOperationTurnTracker.ts`——
    它们的首参本就是 message，非 traceId 槽）。这是**真负向测试**：注入违规即变红。
  - 行为测试：注入 sink，misused 首参含 `Bearer`/`token=sk-…` 形态 → 前缀中不残留
    未脱敏秘密（R7 结构性封堵 + 幂等）。

## 状态所有者与事件顺序

```text
createServiceLogger(scope).info(traceId, ...args)
  └─ write()  ── debug 门（isDebugEnabled）
       ├─ redactServiceLogArg(traceId)（R7：前缀槽同经漏斗；字符串路径，误用也不直出秘密）
       │    └─ source = traceId ? `${scope}][trace:${redactedTraceId}` : scope
       └─ redactLogArgs(args)（模块级懒单例：env 派生 identity + registry；
            字符串/Error 源头脱敏，对象按引用透传，见 R2-04）
            └─ consoleFn(formatLogPrefix(source,pid), ...redactedArgs)
                 ├─ host 进程：console 被 patch → reportHostLog → main 漏斗（对象在此 JSON 化再脱敏，幂等）
                 ├─ CLI/server 进程：各自 console/文件 sink（字符串/Error 源头已脱敏；对象内容见 R2-04）
                 └─ 测试注入 sink：字符串/Error 收到脱敏后文本，对象收到原引用
```

## 失败语义

- redactLine 异常 → `<withheld>`（shared R5）。
- 身份/注册表构建异常 → 最小管线继续，绝不抛出到日志调用方。

## 验收场景

1. 注入 sink 的 createServiceLogger：`info(undefined, "path C:\\Users\\name\\x token=sk-secret…")`
   → sink 收到字符串中 homedir 段为 `<home>`、机密 kv 为 `<redacted>` 形态。
2. Error 参数 → sink 收到脱敏后的 `message + stack` 字符串，堆栈中的
   用户路径被占位符替换。
3. 对象参数在源头按引用透传（形状不变），终局字符串化漏斗再 JSON 化脱敏。
   守护测试钉住：注入 sink 收到对象的原引用（非字符串）；对照字符串参数仍在
   源头脱敏。R2-04 记录非桌面进程的对象内容脱敏缺口为已登记跨文件事项。
4. 合法 `sess_<uuid>` 出现在消息中不触发抑制；非法形态会话 token → 整行 `<withheld>`。
5. 脱敏幂等：同一行过两次管线输出不变。
6. traceId 槽结构性封堵（R7）：注入 sink，misused 首参
   `info("Bearer eyJfake… token=sk-secret…" as any, …)` → sink 收到的**前缀**
   （`formatLogPrefix` 输出，含 `[trace:…]` 段）不含未脱敏秘密原值；对照
   `info(undefined, "msg", {token: "sk-secret…"})` 的 args 侧同样不残留原值。
7. traceId 槽误用守护（R8）：源扫描 `packages/services/src`，无 `ServiceLogger`-typed
   logger 以字面量字符串作 `.info(`/`.warn(`/`.error(`/`.debug(` 首参的调用残留；
   message-first logger（`AgentSparePoolLogger`/`TrackerLogger`）在 allowlist 内豁免。
   真负向测试：向受扫文件注入一处违规调用后本场景变红，撤回后转绿。

## 迁移边界

- 只改 `serviceLogger.ts` 漏斗 + 新增 `packages/services/src/logger/logPrivacy.ts`；
  `createServiceLogger` 公开签名不变。
- CLI 自有 jsonl 日志（apps/acode-cli adapters DefaultLogRedactor）不在本次
  所有权内；其词表与 shared 单源的一致性作为登记项跟踪。
