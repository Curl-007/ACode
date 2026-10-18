# ACode Browser Relay 扩展

Chrome MV3 扩展（源码入仓，无构建步骤），配合 browser-relay 服务端
（`../src/relay/`）让 ACode agent 驱动**你日常使用、已登录的 Chrome 标签**——绕开
Chrome 136+ 默认 profile 对 `--remote-debugging-port` 的禁令，并把「单标签只能挂一个
debugger」的限制多路复用给任意多个 CDP 客户端。

Ported from oh-my-pi (MIT) — `packages/browser-relay/extension/`，
Copyright (c) 2025 Mario Zechner & Stencil Labs。

## 安装

1. 启动 relay 服务端（由消费方进程显式 opt-in 调用 `startRelayServer()` / `RelayLeaseManager`，
   见 `apps/acode-cli/specs/browser-relay-inplace-capture.md`）。
2. 打开 `chrome://extensions` → 开发者模式 → **加载已解压的扩展程序** → 选择本目录
   （`relay-extension/`）。
3. 若 relay 配置了 token 或非默认端口：点击扩展图标 → 在设置页填入相同的 port/token →
   Save。扩展徽标变为 **on** 即已连上 relay。

## 权限自查（最小化记录）

| 权限 | 用途 | 不用时的影响 |
| --- | --- | --- |
| `debugger` | 核心：attach/detach/sendCommand，把 `chrome.debugger` 事件流回 relay | 功能不可用 |
| `tabs` | 标签 RPC（create/remove/activate）与 tabCreated/Updated/Removed 事件 | 无法发现/管理标签 |
| `tabGroups` | 把被驱动标签收进可见的「ACode」组、断连解散 | 标签可见性指示消失 |
| `storage` | instanceId（多浏览器命名空间）+ 端口/token 设置 | 每次重启换身份/无法配置 |
| `alarms` | service worker 被回收后周期唤醒重拨 | relay 断开后不再自动重连 |

**没有**：`host_permissions`（零主机权限，不注入任何页面）、`scripting`、`activeTab`、
`webRequest`、`cookies`。扩展不读取页面内容，只透传 relay 指示的 CDP 命令。

## 安全须知

- 扩展只拨出（`ws://127.0.0.1:<port>/ext`），不开任何入站面。
- token 存 `chrome.storage.local`，只出现在拨出 URL 查询串里；relay 与扩展都不打印它。
- 被驱动的标签始终处于用户可见的青色「ACode」标签组；用户拖出即永久退出分组；
  relay 断开即解散全部 relay 组。
- Chrome 在挂载期间显示「正在调试此浏览器」信息条；用户点「取消」会让该标签退出
  驱动（直到 URL 变化），这是刻意保留的用户否决通道。
