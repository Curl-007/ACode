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

## 6. 第二轮参照机制（桌面 CUA 授权/交互面，十条）

> **来源与基线**：本节来自第二轮六路深挖清册（同一还原工程 `~/Desktop/zoode/Claude-2.37337`
> 的只读研究；清册逐条记录了提示词转储的证据行号，立项落地前按文首复核义务以原文复核）。
> 撰写基线：分支 `feature/value-extract-23737-r2`，HEAD `73d0b3b`，工作区干净。十条均为
> 外部产品**桌面 CUA 授权与交互机制**的参照集，全部不在 §3 的 8 项差距之内（§3 是 AVD
> 设备控制面，本节是桌面 CUA 授权/交互面）——两节互补不重叠；本节与全文一样**只登记、
> 不实施**。

### 6.1 类别化 tier 授权（浏览器类默认只读档）

- **机制**：授权不是「按应用全有或全无」，而是按目标类别 × 能力档（tier）切分——浏览器类
  目标默认「只读档」：截图可见、点击/键入禁用、页面导航必须走专用浏览器工具；授权对话框
  明示当前授予的档位，用户知道「我批准的是哪一层能力」。
- **对 ACode 的启示**：CUA 授权目前是「应用/权限类别 × 允许/拒绝」
  （`packages/services/src/cua-permission-broker/`、权限面板
  `packages/desktop/src/preload/cuaPermissionPanel.ts`），无能力档维度；android/ios 插件
  经 MCP 注册即全工具面暴露（§1.1 的 18 工具里截图与任意 shell 同档）。「只读档」是设备面
  「只看不动」（观察/演示场景）的现成形态；「tier 显示在对话框」可直接采纳为授权 UI 的
  文案纪律。
- **触发条件**：CUA 授权 UI 扩展，或设备插件工具权限分档提上议程（与 §3 #8 的 MCP
  riskLevel 通道同批裁决）。

### 6.2 桌面壳 = allowlist 逃逸面

- **机制**：即便有应用 allowlist，桌面壳本身（桌面/任务栏/文件管理器）就是逃逸面——在壳上
  双击/右键/Enter 可启动清单外任意应用。因此点击落在桌面/任务栏区域需要单独的显式授权
  请求，绝不被「已授权某个应用」隐含覆盖。
- **对 ACode 的启示**：CUA allowlist 语义的设计范本——「窗口坐标属于壳」应是独立的授权
  类别。Helper 原生执行侧从 API 兼容占位（§1.3）走向真实实现时，这条边界应直接写进
  request-access 契约（`packages/acode-cua/request-access-contract.js` 现为占位）。
- **触发条件**：CUA allowlist 面落地（Helper 原生侧或授权契约扩展）。

### 6.3 教学模式独立权限面

- **机制**：识别用户「想学会怎么做」而非「想让 agent 代做」的意图并路由到独立教学模式：
  主界面隐藏、全屏分步覆盖层提示、agent 经专用教学工具逐步推进——agent 当教练不当操作者，
  权限面独立于「代做」（教学面不需要输入注入类授权）。
- **对 ACode 的启示**：与 plan 模式「只说不做」同构，但落在设备控制面。ACode CUA 当前无
  「指导用户亲手操作」模式，也无教学/代做的意图路由；这是独立产品机制（不是安全补丁），
  与外部「让用户亲手操作前先查可见性状态」的浏览器面板协议同族。
- **触发条件**：CUA/设备控制「教学/指导」需求产品化决策。

### 6.4 注意力标记（被驱动窗口描边）

- **机制**：给当前被 agent 驱动的窗口加彩色描边，带前台跟踪（标记随焦点变化）与幂等
  （重复标记不叠加效果）。
- **对 ACode 的启示**：「agent 此刻在动哪个窗口」的可见性机制——用户信任与防误操作（知道
  该窗口正被代驾，不去抢键鼠）。最近挂点是 CUA PiP 会话面
  （`packages/services/src/cua-permission-broker/cuaPipSessionService.ts`），当前无被驱动
  窗口标记。
- **触发条件**：CUA PiP/面板面扩展，或多窗口驱动场景需要视觉锚点。

### 6.5 背景/前景光标双语义 + 坐标契约

- **机制**：区分背景光标与前景光标双语义（agent 驱动 vs 真实用户）；提示词与工具描述中的
  一切坐标锚定在单一契约上——「永远是本截图全分辨率坐标系的像素」，杜绝缩放/偏移漂移。
- **对 ACode 的启示**：CUA SDK 已有「frame 精确栅格」与 state_id 强校验
  （`apps/acode-cli/packages/acode-cua-plugin/scripts/computer-use-client.mjs` 头注
  R1-R3，§1.3），同族且已较强。增量是把「全分辨率截图坐标系」在工具描述里显式锚定——
  HiDPI/显示缩放场景下防模型误用，一句话文案级复核。
- **触发条件**：CUA 工具描述文案触碰时顺带复核（S 级）。

### 6.6 菜单路径优先

- **机制**：凡快捷键可表达的操作，优先走应用菜单路径（找到菜单项点击）而非合成按键——菜单
  可见、可验证、跨键盘布局与 IME 状态稳定；合成键在不同布局/输入法状态下不可靠，且用户
  看不到「发生了什么」。
- **对 ACode 的启示**：CUA 技能文档
  （`apps/acode-cli/packages/acode-cua-plugin/docs/computer-use.md`）与移动插件
  `input_text`/`key_event` 使用指导的行为纪律；Windows 合成键的布局/IME 状态问题同构。
  纯文案层，无代码面。
- **触发条件**：CUA/设备技能文档增补（S，纯文档）。

### 6.7 平台差异诚实

- **机制**：四件——①Wayland 类系统上全屏抓取无法按应用隔离时，仍要求「向用户列出应用」：
  透明性义务不因隔离能力缺失而豁免；②显式披露「被拒绝的应用仍会出现在屏幕抓取里」；
  ③降级模式下的行为分层写进文档；④受保护文件类别「打开即运行的文件类型」（文件管理器
  预览/打开即执行代码）。
- **对 ACode 的启示**：①②是 CUA 平台差异文案的诚实披露范本——Windows 无 macOS 式按应用
  屏幕抓取授权隔离，抓取面与授权粒度应如实披露而非假装等价；④与 §3 #8 shell 逃逸面、
  文件安全面（归档解包信任档）同族——「打开即运行」类别应进设备/桌面文件操作的高危词表。
- **触发条件**：CUA 平台差异披露文案撰写时（①②③）；④随文件安全面立项。

### 6.8 惰性启用（无独立 onboarding）

- **机制**：设备控制能力没有独立的启用引导旅程——agent 实际需要时直接发授权请求，提示出现在
  聊天流内；路由优先级写死：浏览器类任务明确禁用设备控制工具（专用浏览器工具优先）。
- **对 ACode 的启示**：与 MCP 懒重连 + TTL 持久授权
  （`apps/acode-cli/specs/mcp-lifecycle-ttl-approval.md`）哲学同构——授权出现在需要的
  现场，不做前置配置。「浏览器场景禁用 CUA」是本文遗留问题 3（移动 Web 测试场景下
  android 插件 vs browser-use 路由规则未定义）的直接参照答案。
- **触发条件**：遗留问题 3 的产品裁决；惰性启用形态是 CUA 授权面扩展的默认纪律。

### 6.9 GIF 取证记录

- **机制**：agent 驱动操作期间生成 GIF 记录：点击指示、动作标签、进度条、水印，且启动后
  立即截图作为首帧——记录从起始状态开始，不从动作中途开始。
- **对 ACode 的启示**：设备控制动作的审计/回放/用户信任面。ACode 设备插件零持久状态
  （§1.1/§1.2）、无动作记录；与 §3 #3「操作留痕」台账同族——#3 是状态台账，本条是视觉
  取证，可同批裁决。
- **触发条件**：「审计/回放自动化过程」需求出现（与 §3 #3 台账同批）。

### 6.10 集合授权语义

- **机制**：多个待授权应用列进单个对话框（集合授权）：整批允许/整批拒绝；会话中途的新请求
  可追加进已有集合；已授权项保持有效（幂等，不重复弹窗）。
- **对 ACode 的启示**：CUA permission broker 与 TTL 审批 UI 的批量形态参照——避免「一应用
  一弹窗」的打断节奏；「中途追加 + 已授保持」与 TTL 持久授权语义（骨架 `9be0f03` 已落地）
  直接衔接。
- **触发条件**：TTL 审批 UI 批次 spec（第一轮清册登记的同意窗防护套件并入同一批次）。

---

## 对外发布说明

本文只保留机制设计层面的对照结论；外部产品证据一律以「某桌面 agent 产品」指代，
不含厂商内部代号、专有代码或提示词正文字面。研究工程路径以 `~/Desktop/zoode/`
相对形式引用。后续增补保持同一边界。
