# 设备 UI 文本净化层（iOS/Android 插件通用件）

状态：2026-10-15 落地（价值提取第二轮 W2-M1 件4）。机制形态参照外部成熟实现的
公开行为（递归 sanitize、可见字符上限、扫描硬上限、不可见码点闭集过滤、硬件键名
闭集词表），实现全部自撰；不含任何厂商内部标识。

## 背景

- ios-simulator-plugin / android-emulator-plugin 的 MCP 工具把**设备侧文本**直接
  转述进模型上下文：设备名、运行时名、命令 stdout/stderr（ios `spawn`、android
  `shell`/`logcat`/`current_focus` 的窗口标题）、adb/simctl 错误消息。app 可以把
  自己的无障碍标签、窗口名、日志内容写成任意文本——这是提示注入与上下文污染的
  直接入口。
- 威胁形态：不可见码点（双向控制符可视觉重排文本、零宽字符可在词中间走私、
  行分隔符可在 JSON 字符串里伪装换行、孤立代理项破坏 UTF-8 下游、蒙古元音符
  U+180E 是经典不可见走私位、Default_Ignorable 全族随 Unicode 演进）+ 超长串
  挤占上下文。
- ACode 现状核对（2026-10-15）：两插件的 `jsonResult`/`toolError` 直接
  `JSON.stringify` 原样透传，无任何净化面。

## 产品规则

### R1 净化收口：所有设备侧文本经唯一 choke point 进模型

- 两插件的 `jsonResult(payload, cap?)` 与 `toolError(message)` 是结果面唯一出口；
  净化在这两个函数内完成，handler 不各自净化（避免漏点）。
- `content[].text`（JSON 序列化文本）与 `structuredContent` **共用同一份净化后
  payload**：两个通道不会分叉。
- 递归净化（`sanitizeDeviceTextDeep`）：对象/数组逐层下探；字符串净化；**键也
  净化**；`__proto__` 键跳过（不把原型污染面搬进输出对象）；数字/布尔/null 原样；
  深度护栏 32 层。

### R2 单串净化：可见字符上限 + 8× 扫描硬上限 + 不可见码点全滤

- **不可见码点判定（闭集 + 属性类）**：C0（<0x20）、DEL+C1（0x7F–0x9F）、
  U+180E 蒙古元音符、U+2028/U+2029 行/段分隔符、代理区 D800–DFFF、
  U+FFF9–FFFB 行间注解、`\p{Default_Ignorable_Code_Point}` 全族（零宽/双向控制/
  变体选择符/Hangeul 填充/Tags 区，随 Unicode 版本自动跟进）。非法码点
  （>0x10FFFF、非整数）按不可见处理（fail-closed）。
- **可见字符上限分档**（按消费面选型，全部可测）：
  | 档位 | 常量 | 缺省消费面 |
  | --- | --- | --- |
  | 短字段（256 级） | `DEVICE_TEXT_MAX_VISIBLE_CHARS = 256` | 设备名、udid、状态、标识符回显（jsonResult 缺省档） |
  | 输出文本（4096 级） | `DEVICE_OUTPUT_MAX_VISIBLE_CHARS = 4096` | toolError 消息（内嵌 stderr）、宿主路径/URL 回显 |
  | 大块输出（32768 级） | `DEVICE_BULK_OUTPUT_MAX_VISIBLE_CHARS = 32768` | ios `spawn` stdout/stderr、android `shell`/`logcat` |
- **扫描硬上限 = 上限 × 8**（`DEVICE_TEXT_SCAN_MULTIPLIER`）：按码点计数，不可见
  字符同样计入扫描数——由百万个零宽字符组成的串最多扫 2048 码点即止，不给
  「不可见字符海」DoS 面。按码点迭代（for…of），代理对不被劈开。
- **截断可见化**：预算用尽或扫描触顶时追加 `…[truncated]` 标记——模型必须能
  看出文本被截过，不把残文当全文。

### R3 硬件键名闭集词表

- `HARDWARE_KEY_VOCABULARY`（canonical 名 → `{ iosButton?, androidKeycode? }`）：
  home / back / recents / lock / volumeup / volumedown / side。词表是闭集，
  键名类 API 只接受词表内名字。
- `resolveHardwareKeyName(name)`：trim → 小写 → 去 `_`/`-`/空格 分隔后查表
  （`volume_up`、`Volume-Up`、`volumeUp` 同键）；词表外返回 `undefined`——
  **fail-closed，调用方必须显式报错并点名允许的词表**，不静默丢弃（模型需要
  知道哪个名字不被接受）。
- 消费点（本批）：android `key_event` 新增 `key_name` 入参（与 `keycode` 二选
  一）；`keycode` 整数路径维持既有行为（整数进 argv 无注入面）。ios 插件当前
  无按键工具，词表随模块待命（未来按钮面直接消费 `iosButton`）。

### R4 复用与同步纪律

- canonical 文件：`packages/ios-simulator-plugin/scripts/mcp/sanitize.mjs`；
  `packages/android-emulator-plugin/scripts/mcp/sanitize.mjs` 是**逐字节同源
  vendored 副本**（验收测试钉住字节一致）。两插件独立分发、运行时没有共享
  import 路径，vendoring 是刻意选择；修改必须双份同步，测试会在漂移时红。
- 未来若出现第三个设备类插件（或插件获得共享 lib 分发通道），把 canonical
  文件升格为共享消费点并撤销 vendoring——登记为演进方向，不在本批。

## 状态所有者

| 状态 | 所有者 | 备注 |
| --- | --- | --- |
| 净化算法与常量 | sanitize.mjs（纯函数，无状态） | 两插件各持一份同源副本 |
| 结果面收口 | 各插件 server.mjs 的 jsonResult/toolError | handler 不各自净化 |
| 键名词表 | sanitize.mjs `HARDWARE_KEY_VOCABULARY` | 闭集，改动即改 spec |

## 验收场景

1. 不可见码点全滤：C0/C1/U+180E/U+2028/U+2029/孤立代理/FFF9-FFFB/零宽/双向
   控制符/变体选择符逐个进 `isInvisibleCodePoint` 为 true；可见字符为 false。
2. 双向重排攻击样本 `"abc\u202Edel"` 净化后为 `"abcdel"`（控制符消失、可见
   字符保留原序）。
3. 上限与截断：257 个可见字符 → 前 256 + `…[truncated]`；扫描硬上限：1 万个
   零宽字符后跟可见文本 → 输出为空且标记截断（未扫完全串）。
4. 递归净化：嵌套对象/数组逐层净化；键中的不可见码点被滤；`__proto__` 键被
   丢弃；数字/布尔/null 原样。
5. 键名闭集：`HOME`/`volume_up`/`Volume-Up` 归一命中；词表外名字与 non-string
   返回 undefined；android `key_event` 的 key_name 路径词表外显式报错点名词表。
6. vendored 副本与 canonical 逐字节一致（fs 读取比较）。

## 常量定值记录

- 256 / 4096 / 32768 / 8×：短字段档对齐参考实现 256 级；输出档对齐参考实现
  错误文本 4096 级；大块档是 ACode 自有选型（logcat 200 行量级的可用性与上下文
  经济性折中）；8× 扫描倍率对齐参考实现。分档常量集中定义在 sanitize.mjs，
  改档位即改 spec。

## 证据对照（还原工程复核，2026-10-15，只读）

| 机制 | 证据 |
| --- | --- |
| 不可见码点闭集（C0/C1/180E/2028-9/代理区/FFF9-FFFB/Default_Ignorable） | `Claude-2.37337/src/beautified/main/index.chunk-DDF-ogkH.js:54-65`（`te` 判定函数） |
| 256 可见上限 + 8× 扫描硬上限的截断函数 | 同上 `:67-77`（`g`）、`:1921-1927`（`Ei`，`t*8` 扫描预算）、`:1929/1945/2091`（256 档位） |
| 错误文本 4096 档 + 截断标记 | 同上 `:1897`（`wi=4096`）、`:1913-1917`（`… [truncated]`） |
| 硬件键闭集（按键名 → keycode 映射表 + 表外静默丢弃） | 同上 `:4286-4301`（键码映射）、`:4344`（按钮闭集 HOME/BACK/RECENTS/LOCK/VOLUME_UP/VOLUME_DOWN） |
| 递归净化 + `__proto__` 跳过（CLI 侧同族机制） | `Cen/src/beautified-claude-code/chunk-yk583117.js:216-228` |

## 不在本项范围

- 设备截图（PNG 二进制）面的净化：图像不进文本净化层，走各自工具的文件路径面。
- android `dump_ui` 的 XML 文件本体：该工具只回传宿主文件路径，模型经 Read 工具
  读取——文件读取面的截断/净化归 Read 工具既有预算治理，不在插件净化层重复。
- CUA（node_repl 设备控制面）的同层净化：CUA 的 UI 文本面在 node-repl-host /
  broker 链路，另行立项对照本 spec 复用同一算法形态。
