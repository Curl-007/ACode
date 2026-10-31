# CUA（操控电脑）dev 链启用记录与产品缺口登记（2026-10-30）

> 起因：用户指令「把操控电脑集成进去」（指向桌面 `computer-use` 目录）。
> 摸底结论：该目录**仅含 1 个 SKILL.md**（与 ZCode 官方 computer-use 插件 v0.6.5
> 逐字节相同），无代码可集成；ACode 仓内已有自研 U14 链（`cua-producer/` 原生
> producer 14/14 wire handler + `packages/acode-cua` host 客户端 +
> `packages/services/src/cua-permission-broker/`），缺的是**启用与验收**，不是集成。

## 1. dev 链启用 runbook（本机已实证）

```bash
cd cua-producer && npm install && npm run build   # tsc + node-gyp（VS 工具链；D9025 警告无害）
# 起 dev 实例（dev 链接线）：
ACODE_CUA_DEV_MODE=1 ACODE_CUA_DEV_ROOT=<repo>/cua-producer pnpm dev:desktop
# 真机观测面烟测（仓库根；--pointer 人工专属，门禁与脚本双保险永不自动跑）：
node --import tsx cua-producer/scripts/smoke-real.mjs --capture --uia --host
```

实测结果（2026-10-30，Windows 10.0.26300 x64）：

| 层级 | 结果 | 关键数值 |
|---|---|---|
| capture | pass | 1024×576 jpeg、wire base64 37,892 B（≤200 KiB 预算内）、budget_fit=true |
| uia | pass | 9 apps / 4 windows / 17 elements、state_id 去重真、target_source=active |
| host | pass | helper 407ms 两阶段就绪、stop 20ms、pid_match、capabilities 四项真、**pipe_refused=true**（未持 token 连接被拒） |

dev 实例 host 日志实证：`Windows Computer Use Helper ready {generation:1, pid:35956}`、
`[rpc:register] channel "cua-permission"`、CUA operation turn 事件激活/清除——
**host 侧接线全通**，与既往 `invalid-runtime-manifest → broker_unavailable`
（生产链阶段 5 未落地的设计内 fail-closed）形成对照。

## 2. 产品缺口登记（app 层最后一公里，既有缺陷，另立修复分支）

**现象**：dev 实例内 agent 的 node_repl 会话拿不到 CUA bridge
（`agent.computerUse` assertAvailable 抛 unavailable）——node_repl 进程 env 缺
`ACODE_CUA_PERMISSION_BROKER_SOCKET`。

**已排除**（证据）：
- Helper 未就绪：ready 日志在先（19:38:13），失败 spawn 在后（19:47:17，
  `spare_miss_not_warmed` 直 spawn）。
- 设置开关：Settings → Computer Use 开关实测为 ON。
- 内部特性闸：`isACodeCuaInternalFeatureEnabled` 默认 ON。
- spare 认领闸：`resolveClaimEligibility`（node.ts:2197-2198）要求
  `spare.facts.cuaEnabled===true` 才允许 CUA 上下文认领 spare——闸存在但本次为直
  spawn，仍缺凭据。

**嫌疑面**（按序排查起点）：`packages/services/src/node.ts`
`shouldCreateDefaultCuaProductHelper`（:716-728 admission「有内置插件」谓词在 dev
链的取值）、`buildCuaProductHelperAgentEnv`（:1111-1268 静默 `{}` 返回分支：
`if (!host) return {}`）、`spare.facts.cuaEnabled` 铸造点；另见
`packages/services/specs/windows-cua-runtime-resolution.md` 登记在案的
split-brain TODO（transport_ready 与 healthProbe 时序）。

**复现命令**：本文 §1 runbook 起实例 → 新任务发「用 node_repl 执行
`agent.computerUse.computer.list_windows({})`」→ 观察 host 日志无 broker 凭据注入、
agent 报 fail-closed。

## 3. 人工验收命令（C05/C07，指针面人工专属）

```bash
# C07 指针真机验收（会真实移动指针/点击；双保险：flag + env 缺一不可）
ACODE_CUA_SMOKE_POINTER_LIVE=1 node --import tsx cua-producer/scripts/smoke-real.mjs --pointer
```

观测面（§1）已自动过；指针/输入注入面按 `cua-producer/specs/windows-helper-producer.md`
§15 纪律保留人工执行。

## 4. 生产链（阶段 5）仍缺

打包 staging（`windows-cua-helper-assets.mjs` 移植 + electron-builder
`extraResources: tools/cua-helper` + release.yml 条目）、**代码签名**（.node/.dll
无签名会被 Smart App Control 拒载）、manifest 生成（sha256 小写、electronVersion
精确匹配、先签后算 hash）。前置：签名证书。见
`docs/upgrades/product-and-support-2026-10.md:545-546`。

### 阶段 5 前置清单（2026-10-31 登记，按推荐处置）

1. ~~宿主生产门占位补实~~：**已随 PR #15 R1 完成**（`isOfficialCuaPluginEnabledForWorkspace`
   补实为真读盘，`isCuaEnabledForContext` 启用支改读落盘记录；infra 旗标只留
   `shouldEnableDefaultCuaProductHelper` 等打包语义消费点）。
2. ~~packaged dev 旗标硬化~~：**已随 PR #15 R2 完成**（两键进
   `PACKAGED_BOOT_ENV_DROP_KEYS`）。
3. **设置页乐观投影静默路径**（`pluginManagementStoreEnabled.ts:79-108`）：P2 另立，
   阶段 5 前排期修复（开关成为单一权威后，乐观态不合并服务端确认值的静默路径
   会放大「显示态≠落盘态」误判）。
4. **签名证书**：阶段 5 的硬前置；证书到位前生产包 CUA 保持 fail-closed（设计内）。
5. **凭据卫生**：2026-10-31 发现一笔无法归因的本地提交+推送（`440e32b9`，内容已逐文件
   核对=预期改动面无夹带）。处置边界：凭据轮换与计划任务/自启动项排查由**用户本人在
   GitHub/操作系统侧执行**；Agent 不得代读、代展示、代传递或代持有任何新旧凭据
   （本条是人类操作提醒，非 Agent 可执行指令；对外发送类操作逐次征得用户确认）。
