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

## 状态所有者与事件顺序

```text
createServiceLogger(scope).info(traceId, ...args)
  └─ write()  ── debug 门（isDebugEnabled）
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

## 迁移边界

- 只改 `serviceLogger.ts` 漏斗 + 新增 `packages/services/src/logger/logPrivacy.ts`；
  `createServiceLogger` 公开签名不变。
- CLI 自有 jsonl 日志（apps/acode-cli adapters DefaultLogRedactor）不在本次
  所有权内；其词表与 shared 单源的一致性作为登记项跟踪。
