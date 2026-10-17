# 日志隐私脱敏：服务层 serviceLogger 漏斗（services）

核心机制见 `packages/shared/specs/log-privacy-redaction.md`；
桌面漏斗见 `packages/desktop/specs/log-privacy-redaction.md`。

## 产品规则

- R1 `createServiceLogger` 的 `write()` 是服务层日志的**唯一漏斗**
  （86+ 调用点全部经过），脱敏挂在此处，禁止在各 service 调用点散挂。
- R2 漏斗内对 args 做源头脱敏：字符串 → `redactLine`；`Error` →
  以 `message + stack` 合成字符串后 `redactLine`；其他对象**原样透传**
  （不改变日志形状）。对象在终局字符串化漏斗（桌面 main `write()` /
  host `reportHostLog`）JSON 化后再脱敏，双层串联依赖脱敏幂等不变量
  （shared spec「状态所有者」节）。
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
       └─ redactLogArgs(args)（模块级懒单例：env 派生 identity + registry）
            └─ consoleFn(formatLogPrefix(source,pid), ...redactedArgs)
                 ├─ host 进程：console 被 patch → reportHostLog → main 漏斗（再脱敏，幂等）
                 ├─ CLI/server 进程：各自 console/文件 sink（源头已脱敏）
                 └─ 测试注入 sink：直接收到脱敏后 args
```

## 失败语义

- redactLine 异常 → `<withheld>`（shared R5）。
- 身份/注册表构建异常 → 最小管线继续，绝不抛出到日志调用方。

## 验收场景

1. 注入 sink 的 createServiceLogger：`info(undefined, "path C:\\Users\\name\\x token=sk-secret…")`
   → sink 收到字符串中 homedir 段为 `<home>`、机密 kv 为 `<redacted>` 形态。
2. Error 参数 → sink 收到脱敏后的 `message + stack` 字符串，堆栈中的
   用户路径被占位符替换。
3. 对象参数原样透传（形状不变），下游 JSON 化漏斗可再脱敏。
4. 合法 `sess_<uuid>` 出现在消息中不触发抑制；非法形态会话 token → 整行 `<withheld>`。
5. 脱敏幂等：同一行过两次管线输出不变。

## 迁移边界

- 只改 `serviceLogger.ts` 漏斗 + 新增 `packages/services/src/logger/logPrivacy.ts`；
  `createServiceLogger` 公开签名不变。
- CLI 自有 jsonl 日志（apps/acode-cli adapters DefaultLogRedactor）不在本次
  所有权内；其词表与 shared 单源的一致性作为登记项跟踪。
