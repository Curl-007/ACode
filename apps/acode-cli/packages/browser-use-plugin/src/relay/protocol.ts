// Ported from oh-my-pi (MIT) — packages/coding-agent/src/tools/browser/relay/protocol.ts,
// Copyright (c) 2025 Mario Zechner & Stencil Labs. 改名：omp 前缀字段统一为 acode 前缀，
// discardedTabsProtocol 能力位重定义为 relayProtocol（语义不变：能力协商门）。
/**
 * relay 服务端与 Chrome 扩展之间的 wire 协议。
 *
 * 扩展拨出 `ws://127.0.0.1:<port>/ext`，交换 JSON 文本帧。relay 用带编号的 RPC 驱动
 * 扩展；扩展把标签生命周期与 `chrome.debugger` 事件实时回推。
 */

/** relay 与扩展共享的 Chrome 标签最小快照。 */
export interface TabSnapshot {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
  /** Chrome 已丢弃该标签；激活时重新加载。丢弃标签无法应答 debugger 命令。 */
  discarded: boolean;
  windowId: number;
  /** pinned 标签永不分组（分组会静默解 pin）。 */
  pinned: boolean;
  /** Chrome 标签组 id；未分组为 -1。 */
  groupId: number;
}

/** relay 可要求扩展执行的 RPC。 */
export type RelayRpcRequest =
  | { op: "attach"; tabId: number }
  | { op: "detach"; tabId: number }
  | { op: "send"; tabId: number; sessionId?: string; method: string; params?: Record<string, unknown> }
  /** `active: false` 创建标签但不选中；缺省保持 Chrome 默认（选中）。 */
  | { op: "createTab"; url: string; active?: boolean }
  | { op: "removeTab"; tabId: number }
  | { op: "activateTab"; tabId: number }
  /** 把标签加入按窗口的 relay 组（按标题复用/创建），记住原分组以便释放时还原。 */
  | { op: "group"; tabIds: number[]; title: string; color: string }
  /** 把标签还原出 relay 组（或取消分组）；relay 从未分过组的标签是 no-op。 */
  | { op: "ungroup"; tabIds: number[] };

/** relay → 扩展的消息。 */
export type RelayToExtMessage = ({ t: "rpc"; id: number } & RelayRpcRequest) | { t: "pong" };

/** 安全 relay 目标发现与自动挂载所需的能力版本；扩展与 relay 必须一致。 */
export const RELAY_PROTOCOL_VERSION = 1;

/** 扩展 → relay 的消息。 */
export type ExtToRelayMessage =
  | {
      t: "hello";
      userAgent: string;
      browserVersion: string;
      tabs: TabSnapshot[];
      /** 已有 `chrome.debugger` 挂载的标签（relay 在 service worker 重启后对账）。 */
      attachedTabIds: number[];
      /** hello 能力版本；缺失视为过旧扩展，不参与发现/自动挂载。 */
      relayProtocol?: number;
      /**
       * 稳定的每安装浏览器身份（持久化在 `chrome.storage.local`）。让一个 relay 同时
       * 服务多个浏览器：标签按实例命名空间隔离；同 id 的 service worker 重启复用既有
       * 标签注册表而不是顶掉别的浏览器的连接。过旧扩展缺失该字段，共享一个匿名实例，
       * 保持历史 latest-wins 换线语义。
       */
      instanceId?: string;
    }
  | { t: "cdpEvent"; tabId: number; sessionId?: string; method: string; params?: Record<string, unknown> }
  | { t: "detached"; tabId: number; reason: string; relayInitiated?: boolean }
  | { t: "tabCreated"; tab: TabSnapshot }
  | { t: "tabUpdated"; tab: TabSnapshot }
  | { t: "tabRemoved"; tabId: number }
  | { t: "rpcResult"; id: number; ok: boolean; result?: unknown; error?: string }
  | { t: "ping" };
