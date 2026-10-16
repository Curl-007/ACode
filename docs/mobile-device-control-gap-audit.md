# 移动设备控制面差距审计（外部 AVD 控制面对照）

> **定位**：审计/登记文档，**不实施任何改动、不是 spec**。盘点 ACode 当前移动设备控制面
> （Android 模拟器 / iOS 模拟器 / 桌面 CUA 设备控制）的结构、工具面与状态管理，对照某桌面
> agent 产品的 Android AVD 模拟器控制面设计（机制层），产出差距清单。
> **机制情报来源**：对某桌面 agent 产品 2.37337 版还原工程的只读研究（T2-6 节）。证据在
> 本地研究工程 `~/Desktop/zoode/Claude-2.37337`（受 EULA 约束，禁止再分发；本文只搬运机制
> 设计，不使用厂商内部代号；文中 `emulator -console`、adb、simctl 等均为公开工具面）。
> **核实基线**：分支 `feature/cli-value-extract-23737`，HEAD `8898032`。全部 `file:line`
> 以该 HEAD 的干净检出核实；本波次其他代理正在同一工作树并行改动 `apps/acode-cli` 与
> `packages/ui`（本文引用的设备插件文件不在其改动面内），行号漂移风险低但实施前仍需复核。
> **生成日期**：2026-10-15。

---

## 1. ACode 现状盘点（已核实）

### 1.1 android-emulator-plugin（`apps/acode-cli/packages/android-emulator-plugin/`）

- **形态**：插件内置 MCP stdio server（`scripts/mcp/server.mjs`，548 行，newline-delimited
  JSON-RPC 2.0，`server.mjs:473-548` 消息循环），经 `.mcp.json` 注册为
  `android-emulator` server；头注声明「本仓原创、直接面向公开 adb/emulator 命令行、
  未 vendor 任何第三方源」（`server.mjs:1-26`）。
- **工具面（18 个）**：`list_devices`(:89) / `install_apk` / `uninstall` / `launch_app` /
  `stop_app` / `tap` / `swipe` / `input_text` / `key_event` / `screenshot`(:261) /
  `dump_ui`(:281) / `logcat`(:301) / `list_avds`(:321) / `start_avd`(:340) /
  `stop_avd`(:363) / `current_focus`(:379) / `shell`(:400，任意 adb shell 逃逸口) /
  `wait_for_device`(:421)。工具清单与 `skills/android-dev/SKILL.md` 的表格逐一对应。
- **配置面**：`.mcp.json` env 注入 `ANDROID_PLUGIN_ADB/EMULATOR/DEFAULT_AVD/SDK_PATH/
API_LEVEL/...`（user_config 占位符），server 侧读取于 `server.mjs:34-37`。
- **目标解析**：`resolveSerial`（`server.mjs:71-84`）——显式参数 > `ANDROID_SERIAL` env >
  「唯一在线设备」；多台在线且未指定时返回 null（工具报错），**不区分 USB/网络 serial 形态**。
- **状态管理**：**零持久状态**。无状态文件、无启动锁；`start_avd` 为
  `spawn(detached)+unref` 后 `waitForDevice` 同步轮询（`server.mjs:352-361、439-447`）。
- **引导文档**：`skills/android-dev/INSTALL_ENVIRONMENT.md`——逐平台安装命令
  （brew/sdkmanager/avdmanager），技能文档层承担「环境不存在怎么办」的引导；
  但**工具错误结果本身不带引导**（`toolError` 只回显 stderr，`server.mjs:458-460`）。

### 1.2 ios-simulator-plugin（`apps/acode-cli/packages/ios-simulator-plugin/`）

- **形态**：同构 MCP stdio server（`scripts/mcp/server.mjs`，458 行），面向公开
  `xcrun simctl`（`server.mjs:1-20` 头注：macOS only、xcrun 缺失时如实报错不假装）。
- **工具面（15 个）**：`list_devices`(:83) / `list_runtimes`(:108) / `boot`(:127) /
  `shutdown`(:148，支持 `"all"`) / `erase`(:169) / `create_device`(:189) /
  `install_app`(:208) / `uninstall_app`(:228) / `launch_app`(:245) /
  `terminate_app`(:262) / `screenshot`(:279) / `open_url`(:297) / `get_container`(:314) /
  `set_appearance`(:337) / `spawn`(:357)。
- **目标解析**：`resolveDevice`（`server.mjs:52-79`）——UDID 精确 > 名字 + available >
  默认 `IOS_SIM_DEFAULT_DEVICE`（缺省 "iPhone 16"）；「存在但 runtime 未装」给专门
  错误文案（`:74-76`）。
- **幂等/竞态**：`boot` 处理 already-booted（state==="Booted" 直接成功 `:137`；
  stderr 匹配 `/already booted/i` 也放行 `:139-141`）+ `bootstatus -b` 阻塞等就绪
  （`:142-144`）——**iOS 侧有基本的启动竞态处理**。
- **状态管理**：同 Android，零持久状态。

### 1.3 acode-cua-plugin + CUA 双链路（桌面设备控制，非移动端，但状态管理最重）

- **SDK 面**：`apps/acode-cli/packages/acode-cua-plugin/scripts/computer-use-client.mjs`
  （340 行，模型可见面与 Codex 的 `cua` 同构，头注 R1-R3 原则：同名同签 / 能力只减不增 /
  安全语义只藏不删——state_id 强校验、frame 精确栅格、possibly_sent 防重放、
  controller lease、kill switch，`computer-use-client.mjs:1-28`）。14 方法 computer.\*
  面（`:54-69`），经注册 Symbol 由 node-repl host 注入 bridge（`:51`；host 侧
  `apps/acode-cli/packages/node-repl-host/src/cua-bridge.ts:7`）。
- **错误模型**：`computer-use-errors.mjs:15-35` broker→SDK 错误码映射（未登记码一律落
  INTERNAL，「宁可笼统失败重新观察，不把故障静默映射成成功」）；`:41-46`
  REACQUIRE_FIRST（重发前必须重新观察）与 `:51-60` POINTLESS_RETRY（重试只会放大
  副作用）两张闭集表——**这是 ACode 设备控制面里最接近外部「失败面词表」的设计**。
- **双链路 broker**：链路甲 node-repl 内核↔host（随机 UUID socket + 32B token，
  `node-repl-host/src/cua-broker.ts:26-30`）；链路乙 host↔Helper（identity 模式，
  单连接单请求、连接失败 fail-closed、possibly_sent 语义，
  `packages/acode-cua/broker.js:86-90、273-290`）。子代理作用域硬拒 CUA
  （`cua-bridge.ts:45-52`）。
- **services 侧宿主**：`packages/services/src/cua-permission-broker/`（8 文件，
  ~1,939 行）——macOS 权限服务 descriptor（`cuaPermissionService.ts:1-14`）、
  Windows Helper 宿主两阶段传输生命周期状态机（`windowsCuaDevHelperHost.ts:1`）、
  Windows dev runtime（`windowsCuaDevRuntime.ts`，576 行）、PiP 会话服务
  （`cuaPipSessionService.ts:14-23`，skipReason 闭集：service-disabled/disposed/
  credentials-unavailable/transport-disabled）。
- **占位面（本仓构建）**：`packages/acode-cua` 的 Helper 原生执行侧仍为 API 兼容占位
  ——`broker-server.js:6`（"Computer Use is not available in this build."）、
  `pip-session-node.js:1-10`（enabled:false 空实现）、`request-access-contract.js:4-10`
  （safeParse 恒失败）。**但客户端 wire/SDK/bridge/broker 宿主是真实实现**，且
  `packages/shared/src/runtimeEnv.ts:43-44` 注释明写「CUA 现已默认打包进正式版
  （plugin staged + Helper enabled）」——参考文档与 AGENTS.md 的「acode-cua 全
  fail-closed 占位」断言**已部分过时**（详见 §4）。

---

## 2. 外部控制面设计要点（T2-6 转译，机制层）

某桌面 agent 产品的 Android AVD 模拟器控制面（证据：研究工程
`src/beautified/main/index.chunk-DDF-ogkH.js`、`docs/index/string-index.md:1708`）：

1. **设备枚举 + 引导文案**：AVD 枚举尊重 AVD_HOME；列表为空时给「在 Android Studio
   里创建」级别的**面向用户下一步引导**，而非空结果。
2. **启动竞态处理**：「宿主正在启动该 AVD 时又出现同名 AVD」的显式竞态分支——
   启动中的实例与新再现的同名实例不会被混绑。
3. **网络状态控制（飞行模式）**：经 emulator console 控制飞行模式；console 进程
   **崩溃后退避**（不无限重连）；改过飞行模式的 AVD 记入**遗留状态文件**
   （`simulator-airplane-mode-avds.json`，按 AVD 名的 JSON 台账）——宿主重启后能
   识别「哪些设备的网络状态被我改过」，防止把改过的状态误当设备默认态。
4. **完整性校验失败面**：模拟器二进制/镜像的 integrity 失败与 verification 失败是
   **两个独立词**（emulatorIntegrityFailed / emulatorVerificationFailed），分别指向
   「文件损坏」与「校验不通过」两类用户可执行修复。
5. **网络路径设备拒绝**：网络连接（非本机）的 AVD/设备直接拒绝——设备控制面只驱动
   本机模拟器，不驱动网络对端。
6. **窗口/云调用遥测闭集**：原生模拟器窗口事件（opened/focused/refused/closed）与
   云会话调用（done/refused/failed）各为封闭 token 集。
7. **每 app 记忆约定**：`computer-use/<app-name-or-bundle-id>.md` 一 app 一文件，
   记录「哪种做法不行 / 哪种行 / 用了什么工具元素」（证据：
   prompts-and-long-strings.txt 行 26502）——设备控制的经验沉淀面。

---

## 3. 差距清单

> 级别：S=小（≤1 天）M=中（1-3 天）登记=只记录不排期。全部**不实施**。

| #   | 外部机制                                 | ACode 现状（file:line）                                                                                                                                                         | 差距                                                                                                                                                                                                | 建议级别                                                                                                                                       |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 枚举空结果带引导文案                     | `list_avds`（android `server.mjs:321-338`）空列表只回 `{avds:[]}`；引导在技能文档层（`INSTALL_ENVIRONMENT.md` 有 avdmanager create 命令）而非工具错误面                         | 工具结果不带「下一步」——模型未加载技能时拿到空列表无引导。外部范式：错误文案即模型的下一步                                                                                                          | S：`list_avds` 空结果与 `start_avd` 失败文案附「用 avdmanager/Android Studio 创建，或设置 default_avd」提示                                    |
| 2   | 启动竞态（启动中同名设备再现）           | android `start_avd`（`server.mjs:340-361`）spawn detached 后 `waitForDevice` 不绑定 serial——等待期任何设备上线即成功；ios `boot` 有 already-booted 幂等（`server.mjs:136-140`） | Android 侧并发/重入启动可能绑错实例（等待的是「任一设备」而非「我启动的那台」）；无启动锁                                                                                                           | M：start_avd 前快照 serial 集合、只接受新出现的 serial；或 emulator `-read-only`/命名管道 console 绑定实例                                     |
| 3   | 飞行模式控制 + 崩溃退避 + 遗留状态文件   | 两插件均无网络状态工具（grep airplane/wifi/connectivity 零命中）；两插件均零持久状态（§1.1/§1.2）                                                                               | 整面缺失。且外部设计的精髓不是工具本身，而是**「我改过的设备状态」台账**——ACode 设备插件无任何「操作留痕」概念                                                                                      | 登记。触发条件：出现「被测 app 需断网/弱网场景」的自动化测试需求。落地时台账建议进 `ACODE_PLUGIN_DATA`（`.mcp.json` 已预留该 env）而非临时目录 |
| 4   | integrity/verification 双失败词          | 两插件无 integrity/verification 面（grep 零命中）；CUA 面已有同族设计（`computer-use-errors.mjs:15-35` 未登记码落 INTERNAL + `version_mismatch` 独立码）                        | 模拟器二进制/系统镜像损坏只表现为 adb/emulator 的原始 stderr，无分类                                                                                                                                | 登记。触发条件：设备插件错误归因需求（与 #1 的「错误文案即下一步」同批做更划算）；词表形态直接抄 CUA errors.mjs 的映射表纪律                   |
| 5   | 网络路径设备拒绝                         | `resolveSerial`（`server.mjs:71-84`）不识别 `host:port` 形态的网络 serial；`list_devices` 会列出 `adb connect` 的远程设备                                                       | 远程 adb 设备可被 agent 全工具面驱动（tap/shell/install…）——设备控制面越出「本机模拟器」信任边界；`shell` 逃逸口（`server.mjs:400-419`）在远程设备上即远程任意命令                                  | S：缺省拒绝含 `:` 的 serial（显式 `serial` 参数 + 配置 opt-in 才放行）；`shell` 工具对网络设备同样受限                                         |
| 6   | 窗口/云调用遥测闭集                      | ACode 有 no-telemetry 红线（`apps/acode-cli/tests/no-telemetry.test.mjs`；遗留遥测 env 剔除 `runtimeEnv.ts:92-104`）                                                            | **不适用（刻意差异）**：ACode 不做遥测上报。等价物是结构化本地日志事件面（先例：`cua-broker.ts:33-36` 的 `node_repl.cua_broker.request.failed` 事件名 + `cuaPipSessionService.ts` skipReason 闭集） | 不跟进遥测；若要可观测性，按既有事件名纪律落本地 debug 日志                                                                                    |
| 7   | 每 app 记忆文件（computer-use/<app>.md） | ACode 有 memory 子系统，但无设备控制专属记忆约定；CUA 技能文档（`acode-cua-plugin/docs/computer-use.md`）是静态参考非经验沉淀                                                   | 设备操作经验（哪个元素定位不稳、哪种手势有效）无处沉淀，每次会话从零试错                                                                                                                            | S：作为记忆纪律约定采纳——CUA/设备插件技能文档里加「一 app 一记忆文件」写入约定，无需新代码面                                                   |
| 8   | （对照项）shell 逃逸口治理               | android `shell` 工具直传任意命令（`server.mjs:400-419`）；MCP 工具入参不经 Bash AST 治理/熔断器（熔断器只认 `toolName === "Bash"`，`bypass-immune-breakers.ts:86、146`）        | 同等危险的命令经 `android-emulator.shell` 提交时绕过全部 Bash 治理（rm -rf 在设备侧是 `rm -rf /sdcard`，破坏面小但越权面同构）；MCP 工具权限目前按工具名规则匹配                                    | M：评估把高危 MCP 工具（shell 类）纳入项目/托管策略的 ask 缺省，或在权限元数据上给 MCP 工具 riskLevel 通道。与 #5 同批裁决                     |

---

## 4. 参考文档过时断言核实

| 断言（来源）                                                                                   | 核实结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 「`packages/acode-cua` 现全 fail-closed 占位」（外部研究参考文档 T2-6 落点列；AGENTS.md 同句） | **部分过时**。仍占位的：Helper 原生执行侧（`broker-server.js:6`）、PiP 会话客户端（`pip-session-node.js:1-10`）、request-access 契约（`request-access-contract.js:4-10`）。已是真实实现的：链路乙 wire 协议客户端（`broker.js:86-160`）、SDK 插件五模块（acode-cua-plugin/scripts，2,366 行）、node-repl 双链路 bridge（`cua-bridge.ts`/`cua-broker.ts`）、services 侧 broker 宿主含 Windows 两阶段传输状态机（`windowsCuaDevHelperHost.ts`/`windowsCuaDevRuntime.ts`）。且 `runtimeEnv.ts:43-44` 注释声明 CUA 默认打包进正式版（plugin staged + Helper enabled）。AGENTS.md 该句建议随下次修订更新为「Helper 原生侧在本仓为 API 兼容占位，客户端/桥接/宿主链路为真实实现」（本文档只登记，不改 AGENTS.md） |
| 「acode-cua 参考，登记」（外部研究参考文档把 T2-6 落点定为 packages/acode-cua）                | 落点需修正：移动端设备控制的实际落点是 android/ios 两个 MCP 插件（§1.1/§1.2），`packages/acode-cua` 是**桌面**应用控制面；两者工具面、错误模型、状态管理完全独立。差距清单 #3/#4/#7 同时涉及两面，落地时勿混                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

---

## 5. 遗留问题

1. `shell` 逃逸口（#8）与 MCP 工具 riskLevel 通道是权限面设计问题，超出设备插件范围，
   需与 permission 所有者对齐后另立 spec。
2. 启动竞态（#2）的完整解（emulator console 绑定实例）依赖 console 端口管理，
   多会话并发驱动多台 AVD 时还需 serial 会话级隔离——若「设备农场」需求出现再评估。
3. 本文未审计 REA MCP（外部逆向工具面）与 browser-use 插件的设备语义重叠；
   移动 Web 测试场景下 android 插件与 browser-use 的路由规则未定义，登记待产品裁决。

---

## 对外发布说明

本文只保留机制设计层面的对照结论；外部产品证据一律以「某桌面 agent 产品」指代，
不含厂商内部代号、专有代码或提示词正文字面。研究工程路径以 `~/Desktop/zoode/`
相对形式引用。后续增补保持同一边界。
