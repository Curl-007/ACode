/* eslint-disable max-lines -- Ported from oh-my-pi (MIT) upstream 单文件（~1680 行）；按行为照抄移植，
   拆分会偏离上游、阻碍后续同步（与仓库对移植资产关闭 max-lines 的既有豁免一致）。 */
// Ported from oh-my-pi (MIT) — packages/coding-agent/src/tools/browser/relay/bridge.ts,
// Copyright (c) 2025 Mario Zechner & Stencil Labs.
/**
 * `chrome.debugger` 之上的 CDP 门面。
 *
 * 下游 CDP 客户端（puppeteer 系工具，如 agent-browser）把本桥当作 Chrome 的浏览器
 * 调试端点连接。Chrome 每个标签只允许一个 debugger 挂载，因此桥经扩展持有每个标签
 * 唯一一路 `chrome.debugger` 挂载，并用铸造的每连接会话 id 把所有下游连接多路复用到
 * 其上。
 *
 * 模拟面（其余全部转发给 `chrome.debugger`）：
 * - 浏览器目标（`/json/version` 握手、`Browser.getVersion`）
 * - `Target.*` 域，含 puppeteer 的标签 → 页面自动挂载层级
 *   （参考实现：puppeteer-core `cdp/ExtensionTransport.ts`）
 *
 * 下游连接看到的会话 id 命名空间：
 * - 铸造的标签伪会话（`ST<tab>.<conn>.<n>`）——仅用于 Target 模拟
 * - 铸造的页面伪会话（`SP<tab>.<conn>.<n>`）——转发到标签的根 debugger 会话
 * - 真实子会话 id（OOPIF、worker）——Chrome 在共享根会话下创建，原样透传
 */
import { createHash } from "node:crypto";
import { deferred, delay } from "./internal.js";
import { RELAY_PROTOCOL_VERSION } from "./protocol.js";
import type { ExtToRelayMessage, RelayRpcRequest, RelayToExtMessage, TabSnapshot } from "./protocol.js";

/** 本 relay 实现的版本号（`/json/version` 自报；与浏览器版本无关）。 */
export const ACODE_BROWSER_RELAY_VERSION = "0.1.0";

/** 桥写入的传输无关 websocket 面。 */
export interface RelaySocket {
  send(text: string): void;
  close(): void;
}

interface CdpCommand {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/**
 * 每伪会话的 Runtime 域状态。
 * - `default`：从未动过 Runtime——仍接收 relay 的根事件扇出，让从不发送
 *   `Runtime.enable` 的客户端继续收到 `Runtime.executionContextCreated`。
 * - `enabled`：执行过 `Runtime.enable`；收到既有上下文重放。
 * - `disabled`：显式执行过 `Runtime.disable`；静音直到重新 enable。
 */
type RuntimeState = "default" | "enabled" | "disabled";

interface SessionRef {
  kind: "tab" | "page";
  /** 所属标签的注册表键（`<instance 码>:<chrome tabId>`）。 */
  tabKey: string;
  tabId: number;
  runtimeState: RuntimeState;
  /** 已向该伪会话宣布过的上下文 id。 */
  readonly runtimeContexts: Set<number>;
  /** 该会话在途的 `Runtime.enable`；重复调用等待它。 */
  runtimeEnabling: Promise<void> | null;
  /** enable 回滚与重放的单调所有权代号。 */
  runtimeEpoch: number;
  /** 已发送 `Target.setAutoAttach`；只有这种会话会被告知真实子目标。 */
  autoAttach: boolean;
  /** 请求过 `Page.setInterceptFileChooserDialog`；任一会话在要，标签就保持开启。 */
  interceptsFileChooser: boolean;
}

interface TargetInfo {
  targetId: string;
  type: "tab" | "page" | "browser";
  title: string;
  url: string;
  attached: boolean;
  canAccessOpener: boolean;
}

class CdpConnection {
  discover = false;
  autoAttach = false;
  /** 本连接持有的铸造伪会话。 */
  readonly sessions = new Map<string, SessionRef>();
  /** 本连接认领为驱动目标的标签（`ACODE.claimTarget` / `Target.createTarget`）。 */
  readonly claims = new Set<string>();
  /** 真实子会话 id → 宣布它的会话；其事件与 detach 发往那里。 */
  readonly childParents = new Map<string, string>();

  constructor(
    readonly id: number,
    readonly socket: RelaySocket,
  ) {}

  sessionsForTab(tabKey: string, kind?: "tab" | "page"): string[] {
    const out: string[] = [];
    for (const [sessionId, ref] of this.sessions) {
      if (ref.tabKey === tabKey && (!kind || ref.kind === kind)) out.push(sessionId);
    }
    return out;
  }

  /** 该标签上第一个 armed auto-attach 的页面会话；每连接一个，子目标不会被宣布两次。 */
  childTargetSessionForTab(tabKey: string): string | undefined {
    for (const [sessionId, ref] of this.sessions) {
      if (ref.tabKey === tabKey && ref.kind === "page" && ref.autoAttach) return sessionId;
    }
    return undefined;
  }
}

/** 传输被替换是可重试错误，不得永久 ban 掉标签。 */
class ExtensionReplacedError extends Error {}

/** 一个已连接的扩展浏览器实例；每个浏览器/profile 一个。 */
interface ExtInstance {
  instanceId: string;
  /** 由实例 id 派生的稳定短码；用于目标 id（`TAB<code>.<tabId>`）。 */
  code: string;
  socket: RelaySocket | null;
  info: { userAgent: string; browserVersion: string; relayProtocol?: number } | null;
}

/** 目标 id 用的确定性每实例短码：跨 relay 重启稳定。 */
function instanceCode(instanceId: string): string {
  return createHash("sha256").update(instanceId).digest("base64url").slice(0, 8);
}

function tabKeyOf(extCode: string, tabId: number): string {
  return `${extCode}:${tabId}`;
}

function tabTargetIdFromKey(key: string): string {
  return `TAB${key.replace(":", ".")}`;
}

function pageTargetIdFromKey(key: string): string {
  return `PAGE${key.replace(":", ".")}`;
}

function parseTargetId(targetId: string): { key: string; kind: "tab" | "page" } | null {
  const match = /^(TAB|PAGE)([^.]+)\.(\d+)$/.exec(targetId);
  if (!match) return null;
  const kind: "tab" | "page" = match[1] === "TAB" ? "tab" : "page";
  return { key: `${match[2]}:${match[3]}`, kind };
}

class TabState {
  /** 构造体内由所属实例赋值。 */
  readonly tabKey: string;
  url: string;
  title: string;
  active: boolean;
  /** 丢弃的标签无法应答 debugger 命令。 */
  discarded: boolean;
  windowId: number;
  pinned: boolean;
  /** 最近一次快照的 Chrome 标签组 id；未分组为 -1。 */
  groupId: number;
  /** `chrome.debugger` 当前是否挂载在该标签上。 */
  attached = false;
  /** 挂载失败或用户取消了调试条时置位；导航后清除。 */
  banned = false;
  /** 该标签的目标是否已向处于发现态的连接宣布。 */
  announced = false;
  attaching: Promise<boolean> | null = null;
  /** 丢弃会取消等待者，但保留扩展 RPC 供迟到清理。 */
  attachCancelled = false;
  attachGeneration = 0;
  cancelAttach: (() => void) | null = null;
  /** 复活标签被取消的挂载请求最终落定时重试。 */
  retryAttachAfterDiscard = false;
  /** relay 发起的 detach 在途；重新挂载串行排在它后面。 */
  detaching: Promise<void> | null = null;
  /** 最近一次请求的 relay detach 之后，一次成功的挂载完成了。 */
  reattachedAfterDetach = false;
  /** relay 要求扩展关闭该标签（`Target.closeTarget`）；它随后的 detach 不是 Chrome 自己的。 */
  closing = false;
  /** relay 把标签放进 relay 组后为真；`ompGroupId` 记录那个组。 */
  grouped = false;
  /** 组 RPC 在途——抑制 load 期 tabUpdated 突发造成的重复请求。 */
  grouping = false;
  ompGroupId: number | undefined;
  /** 用户把标签拖出 relay 组——永不重新分组。 */
  groupOptOut = false;
  /**
   * 该标签挂载下的真实 Chrome 会话（OOPIF/worker 子会话）：报告每个会话的子会话
   * （根会话为空）与其 `Target.attachedToTarget` 参数。
   */
  readonly realSessions = new Map<string, { parent: string | undefined; event: Record<string, unknown> }>();
  /** 共享根 debugger 会话的活动执行上下文。 */
  readonly runtimeContexts = new Map<number, Record<string, unknown>>();
  /** 桥是否已在共享根上启用 Runtime 域。 */
  rootRuntimeEnabled = false;
  rootRuntimeEnabling: Promise<void> | null = null;
  /** debugger 脱离时废弃在途的 Runtime enable。 */
  runtimeGeneration = 0;
  /** 由 Chrome 自己报告的下一次 detach（非 relay 请求）resolve。 */
  chromeDetach = deferred<void>();

  constructor(
    readonly instanceId: string,
    readonly extCode: string,
    readonly tabId: number,
    snap: TabSnapshot,
  ) {
    this.tabKey = tabKeyOf(extCode, tabId);
    this.url = snap.url;
    this.title = snap.title;
    this.active = snap.active;
    this.discarded = snap.discarded;
    this.windowId = snap.windowId;
    this.pinned = snap.pinned;
    this.groupId = snap.groupId;
  }

  update(snap: TabSnapshot): void {
    this.url = snap.url;
    this.title = snap.title;
    this.active = snap.active;
    this.discarded = snap.discarded;
    this.windowId = snap.windowId;
    this.pinned = snap.pinned;
    this.groupId = snap.groupId;
  }
}

/** `chrome.debugger` 无法挂载的 URL；对下游发现完全隐藏。 */
const INELIGIBLE_URL = /^(chrome|devtools|edge|view-source|chrome-extension|chrome-untrusted|chrome-search):/i;

const RPC_TIMEOUT_MS = 20_000;
const CDP_ERROR_METHOD_NOT_FOUND = -32601;
const CDP_ERROR_SERVER = -32000;
/** Chrome 在挂载结束时对在途命令的回答。 */
const DETACHED_COMMAND_ERROR = /Detached while handling command/;
/** 这类失败等待扩展自行报告 detach 的时长。 */
const CHROME_DETACH_REPORT_MS = 1_000;

/**
 * 下游 CDP 连接与 relay 扩展之间的多路复用桥。每个 relay 服务端一个实例；所有状态都在
 * 这里，扩展 service worker 重启只需重新握手。
 */
export class RelayBridge {
  /** 按 `<instance 码>:<chrome tabId>` 键控的标签注册表；每个浏览器实例一个命名空间。 */
  #tabs = new Map<string, TabState>();
  #conns = new Map<number, CdpConnection>();
  #connSeq = 0;
  #sessionSeq = 0;
  #rpcSeq = 0;
  /** 已连接的扩展浏览器实例，按稳定实例 id 键控。 */
  #instances = new Map<string, ExtInstance>();
  #socketInstance = new Map<RelaySocket, string>();
  /** 最后完成 hello 的实例：回答浏览器级请求并拥有新建标签。 */
  #lastHelloInstance: string | null = null;
  #extensionSeen = false;
  /** 最后一个就绪扩展 socket 关闭的 `Date.now()`；就绪中或从未连过为 null。 */
  #extensionGoneSince: number | null = null;
  #pendingRpc = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  /** 真实子会话 id → 所属标签键，从 `Target.attachedToTarget` 事件习得。 */
  #realSessionTabs = new Map<string, string>();
  #log: (message: string, data?: Record<string, unknown>) => void;
  /** 被驱动标签的分组外观；null 关闭分组。 */
  #group: { title: string; color: string } | null;
  /** 等待下一波组 RPC 的标签；一次一批排队。 */
  #groupQueue: TabState[] = [];
  /** {@link #drainGroupQueue} 运行中为真——组 RPC 绝不重叠。 */
  #groupDraining = false;
  /** 每标签最近一次文件选择器拦截切换；见 {@link #serializeInterception}。 */
  #interceptionTransitions = new Map<string, Promise<void>>();

  constructor(
    opts: {
      log?: (message: string, data?: Record<string, unknown>) => void;
      /** 把 agent 主动驱动的标签归入每窗口一个的 Chrome 标签组。 */
      group?: { title: string; color: string } | null;
    } = {},
  ) {
    this.#log = opts.log ?? (() => {});
    this.#group = opts.group ?? null;
  }

  /** 扩展完成 hello 握手后为真。 */
  get ready(): boolean {
    for (const inst of this.#instances.values()) {
      if (inst.socket && inst.info) return true;
    }
    return false;
  }

  /** 最后完成 hello 的实例（浏览器级请求路由到它）。 */
  #lastHello(): ExtInstance | undefined {
    if (this.#lastHelloInstance) {
      const inst = this.#instances.get(this.#lastHelloInstance);
      if (inst?.socket) return inst;
    }
    for (const inst of this.#instances.values()) {
      if (inst.socket) return inst;
    }
    return undefined;
  }

  /** 第一次 hello 之后为真，且保持为真：区分被回收的 service worker 与没装扩展。 */
  get extensionSeen(): boolean {
    return this.#extensionSeen;
  }

  /** 最后一个就绪扩展断开至今的毫秒数；连接中或从未连过为 null。 */
  get extensionGoneForMs(): number | null {
    return this.#extensionGoneSince === null ? null : Date.now() - this.#extensionGoneSince;
  }

  /** 当前连接的下游 CDP 客户端（puppeteer 等）数量。 */
  get cdpClientCount(): number {
    return this.#conns.size;
  }

  /** `GET /json/version` 的载荷。 */
  versionInfo(wsUrl: string): Record<string, string | number> {
    const info = this.#lastHello()?.info;
    let hasCompatibleExtension = false;
    for (const instance of this.#instances.values()) {
      if (instance.socket && instance.info?.relayProtocol === RELAY_PROTOCOL_VERSION) {
        hasCompatibleExtension = true;
        break;
      }
    }
    const ua = info?.userAgent ?? "";
    return {
      Browser: info?.browserVersion ?? "Chrome/unknown",
      "Protocol-Version": "1.3",
      "User-Agent": ua,
      "V8-Version": "",
      "WebKit-Version": "",
      webSocketDebuggerUrl: wsUrl,
      acodeRelayVersion: ACODE_BROWSER_RELAY_VERSION,
      acodeRelayProtocol: String(RELAY_PROTOCOL_VERSION),
      acodeExtensionRelayProtocol: String(hasCompatibleExtension ? RELAY_PROTOCOL_VERSION : 0),
      acodeRelayCdpClients: this.#conns.size,
    };
  }

  /** `GET /json/list` 的载荷（调试辅助；不提供 per-target 端点）。 */
  listTargets(): Array<Record<string, string>> {
    const out: Array<Record<string, string>> = [];
    for (const tab of this.#tabs.values()) {
      if (!this.#eligible(tab)) continue;
      out.push({
        id: pageTargetIdFromKey(tab.tabKey),
        type: "page",
        title: tab.title,
        url: tab.url,
        active: String(tab.active),
        discarded: String(tab.discarded),
      });
    }
    return out;
  }

  // ---- 扩展生命周期 ---------------------------------------------------------

  #rejectPendingExtensionRpcs(instanceId: string, error: Error): void {
    const prefix = `${instanceId}:`;
    for (const [key, pending] of this.#pendingRpc) {
      if (!key.startsWith(prefix)) continue;
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pendingRpc.delete(key);
    }
  }

  /** 新扩展 socket 已连接；其 hello 决定（或复用）浏览器实例。 */
  extConnected(_socket: RelaySocket): void {
    this.#log("extension socket connected");
  }

  extClosed(socket: RelaySocket): void {
    const instanceId = this.#socketInstance.get(socket);
    if (instanceId === undefined) return;
    this.#socketInstance.delete(socket);
    const inst = this.#instances.get(instanceId);
    if (!inst || inst.socket !== socket) return;
    inst.socket = null;
    this.#rejectPendingExtensionRpcs(instanceId, new Error("relay extension disconnected"));
    // 标签保留在列表里（浏览器可能重连），但丢掉 debugger 派生态：挂载随 service worker 一起死了。
    for (const tab of this.#tabs.values()) {
      if (tab.instanceId !== instanceId) continue;
      tab.attached = false;
      tab.attaching = null;
      this.#resetRuntime(tab);
      // 扩展断开时解散 relay 组（或与组同死）；下次 hello 前分组态不可知。
      tab.grouped = false;
      tab.grouping = false;
      tab.ompGroupId = undefined;
    }
    this.#groupQueue = this.#groupQueue.filter(tab => tab.instanceId !== instanceId);
    if (!this.ready) this.#extensionGoneSince ??= Date.now();
  }

  extMessage(socket: RelaySocket, raw: string): void {
    let msg: ExtToRelayMessage;
    try {
      msg = JSON.parse(raw) as ExtToRelayMessage;
    } catch {
      this.#log("dropping malformed extension message");
      return;
    }
    if (msg.t === "hello") {
      this.#onHello(socket, msg);
      return;
    }
    const instanceId = this.#socketInstance.get(socket);
    if (instanceId === undefined) return;
    const inst = this.#instances.get(instanceId);
    if (!inst || inst.socket !== socket) return;
    switch (msg.t) {
      case "rpcResult": {
        const key = `${instanceId}:${msg.id}`;
        const pending = this.#pendingRpc.get(key);
        if (!pending) return;
        this.#pendingRpc.delete(key);
        clearTimeout(pending.timer);
        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(new Error(msg.error ?? "extension rpc failed"));
        return;
      }
      case "cdpEvent":
        this.#onCdpEvent(tabKeyOf(inst.code, msg.tabId), msg.sessionId, msg.method, msg.params);
        return;
      case "detached":
        this.#onTabDetached(tabKeyOf(inst.code, msg.tabId), msg.reason, msg.relayInitiated === true);
        return;
      case "tabCreated":
        this.#onTabUpsert(msg.tab, instanceId);
        return;
      case "tabUpdated":
        this.#onTabUpsert(msg.tab, instanceId);
        return;
      case "tabRemoved":
        this.#onTabRemoved(tabKeyOf(inst.code, msg.tabId));
        return;
      case "ping":
        socket.send(JSON.stringify({ t: "pong" } satisfies RelayToExtMessage));
        return;
    }
  }

  #onHello(socket: RelaySocket, msg: Extract<ExtToRelayMessage, { t: "hello" }>): void {
    // 没有 instance id 的 hello（过旧扩展）共享一个匿名实例，保持历史 latest-wins 换线语义。
    const instanceId = typeof msg.instanceId === "string" && msg.instanceId.length > 0 ? msg.instanceId : "anon";
    let inst = this.#instances.get(instanceId);
    if (!inst) {
      inst = { instanceId, code: instanceCode(instanceId), socket: null, info: null };
      this.#instances.set(instanceId, inst);
    } else if (inst.socket && inst.socket !== socket) {
      // 同一浏览器重连（service worker 重启）：退役旧 socket。debugger 派生态随旧挂载
      // 一起死亡，按旧单槽换线的做法重置 runtime 态；hello 的 attachedTabIds 对账紧随其后。
      for (const tab of this.#tabs.values()) {
        if (tab.instanceId === instanceId) this.#resetRuntime(tab);
      }
      this.#rejectPendingExtensionRpcs(instanceId, new ExtensionReplacedError());
      this.#socketInstance.delete(inst.socket);
      inst.socket.close();
    }
    inst.socket = socket;
    this.#socketInstance.set(socket, instanceId);
    inst.info = {
      userAgent: msg.userAgent,
      browserVersion: msg.browserVersion,
      relayProtocol: msg.relayProtocol,
    };
    this.#lastHelloInstance = instanceId;
    this.#extensionSeen = true;
    this.#extensionGoneSince = null;
    // hello GC 只作用于本实例：别的浏览器的标签不受影响——这是 Chrome 和 Edge 共用一个
    // relay 的前提。
    const seen = new Set<number>();
    const attachedNow = new Set(msg.attachedTabIds);
    for (const snap of msg.tabs) {
      seen.add(snap.tabId);
      this.#onTabUpsert(snap, instanceId, { silent: true });
    }
    for (const [key, tab] of this.#tabs) {
      if (tab.instanceId !== instanceId || seen.has(tab.tabId)) continue;
      this.#onTabRemoved(key);
    }
    for (const tab of this.#tabs.values()) {
      if (tab.instanceId !== instanceId) continue;
      const wasAttached = tab.attached;
      tab.attached = attachedNow.has(tab.tabId);
      tab.attaching = null;
      tab.cancelAttach = null;
      tab.attachCancelled = false;
      if (!tab.attached) this.#forgetChildren(tab);
      if (tab.discarded) {
        // 现在就撤销持有的会话；复活时会重新宣布并挂载标签。
        this.#retractTab(tab);
        this.#detachIfUnheld(tab.tabKey);
        continue;
      }
      // service worker 重启可能在下游仍持有会话时丢掉挂载：best-effort 恢复。
      if (wasAttached && !tab.attached && this.#sessionHolders(tab.tabKey).length > 0) {
        void this.#ensureAttached(tab).then(ok => {
          if (!ok) this.#onTabDetached(tab.tabKey, "reattach_failed", false);
        });
      }
    }
    this.#syncGrouping();
    this.#log("extension connected", {
      instanceId,
      tabs: msg.tabs.length,
      version: msg.browserVersion,
    });
  }

  // ---- 下游（puppeteer）生命周期 ---------------------------------------------

  /** 注册一条下游 CDP websocket；返回连接 id。 */
  cdpConnected(socket: RelaySocket): number {
    const conn = new CdpConnection(++this.#connSeq, socket);
    this.#conns.set(conn.id, conn);
    this.#log("cdp client connected", { conn: conn.id });
    return conn.id;
  }

  cdpClosed(connId: number): void {
    const conn = this.#conns.get(connId);
    if (!conn) return;
    this.#conns.delete(connId);
    const touched = new Set<string>();
    const intercepting = new Set<string>();
    for (const ref of conn.sessions.values()) {
      touched.add(ref.tabKey);
      if (ref.interceptsFileChooser) intercepting.add(ref.tabKey);
    }
    conn.sessions.clear();
    for (const tabKey of intercepting) this.#releaseFileChooserInterception(tabKey);
    // 被 close 的连接 claim 的标签离开 relay 组——除非还有别的 claimant。
    // 会话持有者不算：长驻 registry 连接对每个标签都持会话，但不驱动任何标签。
    for (const tabId of conn.claims) {
      const tab = this.#tabs.get(tabId);
      if (tab) this.#syncTabGrouping(tab);
    }
    conn.claims.clear();
    // 无人再驱动的标签丢掉 debugger（连同它的信息条）。
    for (const tabKey of touched) this.#detachIfUnheld(tabKey);
    this.#log("cdp client closed", { conn: connId });
  }

  cdpMessage(connId: number, raw: string): void {
    const conn = this.#conns.get(connId);
    if (!conn) return;
    let msg: CdpCommand;
    try {
      msg = JSON.parse(raw) as CdpCommand;
    } catch {
      return;
    }
    if (typeof msg.id !== "number" || typeof msg.method !== "string") return;
    void this.#handleCdpCommand(conn, msg).catch(err => {
      this.#replyError(conn, msg, err instanceof Error ? err.message : String(err));
    });
  }

  // ---- 命令路由 --------------------------------------------------------------

  async #handleCdpCommand(conn: CdpConnection, msg: CdpCommand): Promise<void> {
    const sessionId = msg.sessionId;
    if (!sessionId) {
      await this.#handleBrowserCommand(conn, msg);
      return;
    }
    const ref = conn.sessions.get(sessionId);
    if (ref?.kind === "tab") {
      this.#handleTabSessionCommand(conn, msg, ref);
      return;
    }
    if (ref?.kind === "page") {
      await this.#handlePageSessionCommand(conn, msg, sessionId, ref);
      return;
    }
    const realTabKey = this.#realSessionTabs.get(sessionId);
    if (realTabKey !== undefined) {
      const announce =
        msg.method === "Target.setAutoAttach" && msg.params?.autoAttach === true && conn.childParents.has(sessionId)
          ? () => this.#announceChildren(conn, realTabKey, sessionId, sessionId)
          : undefined;
      await this.#forwardToTab(conn, msg, realTabKey, sessionId, announce);
      return;
    }
    this.#replyError(conn, msg, `Unknown session id ${sessionId}`);
  }

  async #handlePageSessionCommand(
    conn: CdpConnection,
    msg: CdpCommand,
    sessionId: string,
    ref: SessionRef,
  ): Promise<void> {
    if (msg.method === "Runtime.disable") {
      ref.runtimeState = "disabled";
      ref.runtimeEpoch++;
      ref.runtimeContexts.clear();
      // 放弃在途 enable 的所有权：之后的 enable 全新开始，而不是加入先于本次 disable
      // 的循环。
      ref.runtimeEnabling = null;
      this.#reply(conn, msg, {});
      return;
    }
    if (msg.method !== "Runtime.enable") {
      if (msg.method === "Target.setAutoAttach") {
        // 在途即 armed（Chrome 会在应答前报告既有子目标）；失败的请求恢复原状态。
        const previous = ref.autoAttach;
        ref.autoAttach = msg.params?.autoAttach === true;
        const announce = () => {
          const parent = conn.childTargetSessionForTab(ref.tabKey);
          if (parent && conn.sessions.get(sessionId) === ref)
            this.#announceChildren(conn, ref.tabKey, undefined, parent);
        };
        if (!(await this.#forwardToTab(conn, msg, ref.tabKey, undefined, ref.autoAttach ? announce : undefined))) {
          ref.autoAttach = previous;
        }
        return;
      }
      if (msg.method === "Page.setInterceptFileChooserDialog") {
        // 一个标签的全部会话共享一个 debugger 挂载，拦截在这里是标签级：一个会话关掉
        // 它不得取消另一个会话的选择器等待。
        await this.#serializeInterception(ref.tabKey, async () => {
          const previous = ref.interceptsFileChooser;
          ref.interceptsFileChooser = msg.params?.enabled === true;
          const params = { ...msg.params, enabled: this.#interceptsFileChooser(ref.tabKey) };
          if (!(await this.#forwardToTab(conn, { ...msg, params }, ref.tabKey, undefined))) {
            ref.interceptsFileChooser = previous;
          }
        });
        return;
      }
      await this.#forwardToTab(conn, msg, ref.tabKey, undefined);
      return;
    }
    // 管线化的重复调用必须等待在途 enable，绝不提前 ack：根循环仍可能失败，成功必须
    // 排在上下文重放之后。
    if (ref.runtimeEnabling) {
      await this.#awaitEnable(conn, msg, ref.runtimeEnabling);
      return;
    }
    if (ref.runtimeState === "enabled") {
      this.#reply(conn, msg, {});
      return;
    }
    const enabling = this.#enableSessionRuntime(conn, sessionId, ref);
    ref.runtimeEnabling = enabling;
    try {
      await this.#awaitEnable(conn, msg, enabling);
    } finally {
      if (ref.runtimeEnabling === enabling) ref.runtimeEnabling = null;
    }
  }

  /** 用共享 enable 的结果应答一条 `Runtime.enable` 命令。 */
  async #awaitEnable(conn: CdpConnection, msg: CdpCommand, enabling: Promise<void>): Promise<void> {
    try {
      await enabling;
      this.#reply(conn, msg, {});
    } catch (err) {
      this.#replyError(conn, msg, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * 为一个会话驱动共享的根 `Runtime.enable` 并把活动上下文重放给它。根循环失败即拒绝，
   * 让所有加入者都观察到失败而不是伪成功。
   */
  async #enableSessionRuntime(conn: CdpConnection, sessionId: string, ref: SessionRef): Promise<void> {
    const prev = ref.runtimeState;
    const epoch = ++ref.runtimeEpoch;
    ref.runtimeState = "enabled";
    const tab = this.#tabs.get(ref.tabKey);
    if (!tab) {
      ref.runtimeState = prev;
      throw new Error(`No tab ${ref.tabKey}`);
    }
    try {
      await this.#ensureRuntimeEnabled(tab);
      // 根 RPC 在途时 disable 或更新的 enable 可能已取得所有权；只有最新的 enable 可以
      // 重放或回滚。
      if (conn.sessions.get(sessionId) === ref && ref.runtimeEpoch === epoch && ref.runtimeState === "enabled") {
        this.#replayRuntimeContexts(conn, sessionId, ref, tab);
      }
    } catch (err) {
      if (ref.runtimeEpoch === epoch) {
        ref.runtimeState = prev;
        ref.runtimeContexts.clear();
      }
      throw err;
    }
  }

  async #ensureRuntimeEnabled(tab: TabState): Promise<void> {
    if (tab.rootRuntimeEnabled) return;
    if (tab.rootRuntimeEnabling) return await tab.rootRuntimeEnabling;

    const enabling = this.#cycleRuntime(tab);
    tab.rootRuntimeEnabling = enabling;
    const generation = tab.runtimeGeneration;
    try {
      await enabling;
      if (tab.runtimeGeneration === generation) tab.rootRuntimeEnabled = true;
    } finally {
      if (tab.rootRuntimeEnabling === enabling) tab.rootRuntimeEnabling = null;
    }
  }

  async #cycleRuntime(tab: TabState): Promise<void> {
    const inst = this.#instanceFor(tab);
    await this.#rpc({ op: "send", tabId: tab.tabId, method: "Runtime.disable" }, inst);
    await this.#rpc({ op: "send", tabId: tab.tabId, method: "Runtime.enable" }, inst);
  }

  #replayRuntimeContexts(conn: CdpConnection, sessionId: string, ref: SessionRef, tab: TabState): void {
    for (const [contextId, params] of tab.runtimeContexts) {
      if (ref.runtimeContexts.has(contextId)) continue;
      ref.runtimeContexts.add(contextId);
      conn.socket.send(JSON.stringify({ sessionId, method: "Runtime.executionContextCreated", params }));
    }
  }

  /**
   * Chrome 只向最先 armed 的 auto-attach 报告一次子目标，所以后 armed 的连接（tab
   * worker 晚于 registry 连接）在这里被告知 `parent`（undefined 为根）之下已报告而它
   * 尚未听过的子目标。
   */
  #announceChildren(conn: CdpConnection, tabKey: string, parent: string | undefined, sessionId: string): void {
    const tab = this.#tabs.get(tabKey);
    if (!tab) return;
    for (const [child, known] of tab.realSessions) {
      if (known.parent !== parent || conn.childParents.has(child)) continue;
      conn.childParents.set(child, sessionId);
      conn.socket.send(JSON.stringify({ sessionId, method: "Target.attachedToTarget", params: known.event }));
    }
  }

  /**
   * 把命令转发给标签并应答；resolve 命令是否成功。`beforeReply` 在应答前于成功路径运行。
   * Target 生命周期命令由 relay 的浏览器处理器应答（自行 reply 或抛给 `cdpMessage`）：
   * 它们 resolve `true`。
   */
  async #forwardToTab(
    conn: CdpConnection,
    msg: CdpCommand,
    tabKey: string,
    realSessionId: string | undefined,
    beforeReply?: () => void,
  ): Promise<boolean> {
    // 护栏：page 会话绝不能拖垮整个浏览器。
    if (msg.method === "Browser.close") {
      this.#reply(conn, msg, {});
      return true;
    }
    // relay 私有认领：驱动方标记它要驱动的页面。绝不转发——真 Chrome 会拒绝未知方法。
    if (msg.method === "ACODE.claimTarget") {
      this.#claimTab(conn, tabKey);
      this.#reply(conn, msg, {});
      return true;
    }
    const tab = this.#tabs.get(tabKey);
    if (!tab) {
      this.#replyError(conn, msg, `No tab with key ${tabKey}`);
      return false;
    }
    const inst = this.#instances.get(tab.instanceId);
    if (!inst || !inst.socket) {
      this.#replyError(conn, msg, "relay extension is not connected");
      return false;
    }
    // 原样转发时 createTarget 会按 `newWindow` 开新窗口并用 Chrome 的 id 应答，relay 命令
    // 无法解析；close/activate 被拒绝（"Not allowed"）。在标签所在浏览器里执行，新建标签
    // 与每个 relay 创建的标签一样落在该浏览器的当前窗口。
    if (
      msg.method === "Target.createTarget" ||
      msg.method === "Target.closeTarget" ||
      msg.method === "Target.activateTarget"
    ) {
      await this.#handleBrowserCommand(conn, msg, tab);
      return true;
    }
    try {
      const result = await this.#rpc(
        {
          op: "send",
          tabId: tab.tabId,
          sessionId: realSessionId,
          method: msg.method,
          params: msg.params,
        },
        inst,
      );
      beforeReply?.();
      this.#reply(conn, msg, (result as Record<string, unknown> | undefined) ?? {});
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Chrome 在报告 detach 之前就fail了根会话的在途命令。把失败压到 detach 报告之后，
      // 客户端先收到 `ACODE.debuggerDetached`、知道原因。
      if (realSessionId === undefined && tab.attached && DETACHED_COMMAND_ERROR.test(message)) {
        await Promise.race([tab.chromeDetach.promise, delay(CHROME_DETACH_REPORT_MS)]);
      }
      this.#replyError(conn, msg, message);
      return false;
    }
  }

  /**
   * 记录 `conn` 为标签的驱动方并对账分组。认领是显式的（worker 领养或标签创建），不从
   * 命令流量推断：目标发现会对每个页面发同样的命令，推断会把所有标签都卷进来。
   */
  #claimTab(conn: CdpConnection, tabKey: string): void {
    const tab = this.#tabs.get(tabKey);
    if (!tab) return;
    if (!conn.claims.has(tabKey)) {
      conn.claims.add(tabKey);
      this.#log("tab claimed", { conn: conn.id, tabKey });
    }
    this.#syncTabGrouping(tab);
  }

  /** 是否有下游连接把该标签认领为驱动目标。 */
  #claimed(tabKey: string): boolean {
    for (const conn of this.#conns.values()) {
      if (conn.claims.has(tabKey)) return true;
    }
    return false;
  }

  /** 标签伪会话只为满足 puppeteer 的 Target 层级而存在。 */
  #handleTabSessionCommand(conn: CdpConnection, msg: CdpCommand, ref: SessionRef): void {
    switch (msg.method) {
      case "Target.setAutoAttach": {
        const tab = this.#tabs.get(ref.tabKey);
        if (!tab) {
          this.#replyError(conn, msg, `Tab ${ref.tabKey} is gone`);
          return;
        }
        // 先发事件再应答：puppeteer 的 TargetManager 在 setAutoAttach 应答 resolve 前统计
        // 已挂载的 page 子目标。
        const pageSession = this.#mintSession(conn, "page", tab);
        this.#emit(
          conn,
          "Target.attachedToTarget",
          {
            sessionId: pageSession,
            targetInfo: this.#pageInfo(tab, true),
            waitingForDebugger: false,
          },
          msg.sessionId,
        );
        this.#reply(conn, msg, {});
        return;
      }
      case "Runtime.runIfWaitingForDebugger":
        this.#reply(conn, msg, {});
        return;
      case "Target.detachFromTarget": {
        const child = typeof msg.params?.sessionId === "string" ? msg.params.sessionId : undefined;
        if (child) this.#releaseSession(conn, child, msg.sessionId);
        this.#reply(conn, msg, {});
        return;
      }
      default:
        this.#replyError(conn, msg, `'${msg.method}' is not supported on a tab target`, CDP_ERROR_METHOD_NOT_FOUND);
    }
  }

  /** `near`：发出命令的会话所属标签；它创建的标签开在同一个浏览器里。 */
  async #handleBrowserCommand(conn: CdpConnection, msg: CdpCommand, near?: TabState): Promise<void> {
    switch (msg.method) {
      case "Browser.getVersion": {
        this.#reply(conn, msg, {
          protocolVersion: "1.3",
          product: this.#lastHello()?.info?.browserVersion ?? "Chrome/unknown",
          revision: "",
          userAgent: this.#lastHello()?.info?.userAgent ?? "",
          jsVersion: "",
        });
        return;
      }
      case "Target.getBrowserContexts":
        this.#reply(conn, msg, { browserContextIds: [] });
        return;
      case "Target.getTargets": {
        const targetInfos: TargetInfo[] = [];
        for (const tab of this.#tabs.values()) {
          if (this.#eligible(tab)) targetInfos.push(this.#pageInfo(tab, tab.attached));
        }
        this.#reply(conn, msg, { targetInfos });
        return;
      }
      case "Target.setDiscoverTargets": {
        conn.discover = true;
        for (const tab of this.#tabs.values()) {
          if (!this.#eligible(tab)) continue;
          tab.announced = true;
          this.#emit(conn, "Target.targetCreated", { targetInfo: this.#tabInfo(tab, tab.attached) });
          this.#emit(conn, "Target.targetCreated", { targetInfo: this.#pageInfo(tab, tab.attached) });
        }
        this.#reply(conn, msg, {});
        return;
      }
      case "Target.setAutoAttach": {
        conn.autoAttach = true;
        // 丢弃的标签会卡死 debugger 调用。把 setDiscoverTargets 已宣布的目标撤回，
        // 让 Puppeteer 能完成 connect()。
        const tabs = [...this.#tabs.values()].filter(tab => this.#eligible(tab) && !tab.discarded);
        await Promise.all(tabs.map(tab => this.#ensureAttached(tab, { retryAfterDiscard: true })));
        for (const tab of tabs) {
          if (!tab.attached || tab.discarded || !this.#eligible(tab)) {
            // 失败或刚丢弃的标签不得拖住 connect()。
            this.#retractTab(tab);
            this.#detachIfUnheld(tab.tabKey);
            continue;
          }
          this.#emitTabAttached(conn, tab);
        }
        for (const tab of this.#tabs.values()) {
          if (tab.announced && tab.discarded && this.#eligible(tab)) {
            this.#retractTab(tab);
            this.#detachIfUnheld(tab.tabKey);
          }
        }
        this.#reply(conn, msg, {});
        return;
      }
      case "Target.attachToTarget": {
        const parsed = typeof msg.params?.targetId === "string" ? parseTargetId(msg.params.targetId) : null;
        const tab = parsed ? this.#tabs.get(parsed.key) : undefined;
        if (!parsed || !tab) {
          this.#replyError(conn, msg, `No target with id ${String(msg.params?.targetId)}`);
          return;
        }
        if (tab.discarded) {
          this.#replyError(conn, msg, `Cannot attach to discarded tab ${tab.tabKey}`);
          return;
        }
        if (!(await this.#ensureAttached(tab))) {
          this.#replyError(conn, msg, `Cannot attach to tab ${tab.tabKey} (${tab.url})`);
          return;
        }
        const sessionId = this.#mintSession(conn, parsed.kind, tab);
        const info = parsed.kind === "tab" ? this.#tabInfo(tab, true) : this.#pageInfo(tab, true);
        this.#emit(conn, "Target.attachedToTarget", { sessionId, targetInfo: info, waitingForDebugger: false });
        this.#reply(conn, msg, { sessionId });
        return;
      }
      case "Target.detachFromTarget": {
        const sessionId = typeof msg.params?.sessionId === "string" ? msg.params.sessionId : undefined;
        if (sessionId) this.#releaseSession(conn, sessionId, undefined);
        this.#reply(conn, msg, {});
        return;
      }
      case "Target.createTarget": {
        const url =
          typeof msg.params?.url === "string" && msg.params.url.length > 0 ? msg.params.url : "about:blank";
        const inst = near ? this.#instances.get(near.instanceId) : this.#lastHello();
        if (!inst || !inst.socket) {
          this.#replyError(conn, msg, "relay extension is not connected");
          return;
        }
        // CDP `background: true` 创建标签但不选中；缺 `active` 的旧扩展忽略之。
        const active = msg.params?.background === true ? false : undefined;
        const result = (await this.#rpc({ op: "createTab", url, active }, inst)) as { tab: TabSnapshot };
        this.#onTabUpsert(result.tab, inst.instanceId);
        // 创建标签是显式的驱动行为。
        const createdKey = tabKeyOf(inst.code, result.tab.tabId);
        this.#claimTab(conn, createdKey);
        this.#reply(conn, msg, { targetId: pageTargetIdFromKey(createdKey) });
        return;
      }
      case "Target.closeTarget": {
        const parsed = typeof msg.params?.targetId === "string" ? parseTargetId(msg.params.targetId) : null;
        if (!parsed) {
          this.#replyError(conn, msg, `No target with id ${String(msg.params?.targetId)}`);
          return;
        }
        const removedTab = this.#tabs.get(parsed.key);
        if (!removedTab) {
          this.#replyError(conn, msg, `No target with id ${String(msg.params?.targetId)}`);
          return;
        }
        removedTab.closing = true;
        try {
          await this.#rpc({ op: "removeTab", tabId: removedTab.tabId }, this.#instanceFor(removedTab));
        } catch (err) {
          // 标签还开着，之后的 detach 又是 Chrome 自己的了。
          removedTab.closing = false;
          throw err;
        }
        this.#reply(conn, msg, { success: true });
        return;
      }
      case "Target.activateTarget": {
        const parsed = typeof msg.params?.targetId === "string" ? parseTargetId(msg.params.targetId) : null;
        const activatedTab = parsed ? this.#tabs.get(parsed.key) : undefined;
        if (parsed && activatedTab) {
          await this.#rpc({ op: "activateTab", tabId: activatedTab.tabId }, this.#instanceFor(activatedTab));
        } else if (near) {
          // page 会话里的原始 activate 失败了；不要把未知 id 变成那里的成功。
          this.#replyError(conn, msg, `No target with id ${String(msg.params?.targetId)}`);
          return;
        }
        this.#reply(conn, msg, {});
        return;
      }
      case "Target.getTargetInfo": {
        const raw = typeof msg.params?.targetId === "string" ? msg.params.targetId : undefined;
        const parsed = raw ? parseTargetId(raw) : null;
        const tab = parsed ? this.#tabs.get(parsed.key) : undefined;
        if (parsed && tab) {
          const info =
            parsed.kind === "tab" ? this.#tabInfo(tab, tab.attached) : this.#pageInfo(tab, tab.attached);
          this.#reply(conn, msg, { targetInfo: info });
          return;
        }
        this.#reply(conn, msg, {
          targetInfo: {
            targetId: "relay-browser",
            type: "browser",
            title: "",
            url: "",
            attached: true,
            canAccessOpener: false,
          } satisfies TargetInfo,
        });
        return;
      }
      case "Browser.close":
        // 永不关闭用户的浏览器；应答并忽略。
        this.#log("refusing Browser.close from downstream client", { conn: conn.id });
        this.#reply(conn, msg, {});
        return;
      case "Browser.setDownloadBehavior":
        this.#reply(conn, msg, {});
        return;
      case "Target.createBrowserContext":
        this.#replyError(conn, msg, "Browser contexts are not supported by the ACode browser relay");
        return;
      default:
        this.#replyError(conn, msg, `'${msg.method}' wasn't found`, CDP_ERROR_METHOD_NOT_FOUND);
    }
  }

  // ---- 扩展事件 ----------------------------------------------------------------

  #onCdpEvent(
    tabKey: string,
    sourceSessionId: string | undefined,
    method: string,
    params?: Record<string, unknown>,
  ): void {
    const tab = this.#tabs.get(tabKey);
    if (!tab) return;
    // 记录真实子会话，让下游命令可以路由回去。
    if (method === "Target.attachedToTarget") {
      const child = params?.sessionId;
      if (typeof child === "string" && params) {
        tab.realSessions.set(child, { parent: sourceSessionId, event: params });
        this.#realSessionTabs.set(child, tabKey);
      }
    } else if (method === "Target.detachedFromTarget") {
      const child = params?.sessionId;
      if (typeof child === "string") {
        tab.realSessions.delete(child);
        this.#realSessionTabs.delete(child);
      }
    }
    if (sourceSessionId) {
      // 真实子会话的事件：原样透传给每一个被告知该子目标的连接，并跟踪嵌套子目标。
      const nested = typeof params?.sessionId === "string" ? params.sessionId : undefined;
      const payload = JSON.stringify({ sessionId: sourceSessionId, method, params });
      for (const conn of this.#conns.values()) {
        if (!conn.childParents.has(sourceSessionId)) continue;
        conn.socket.send(payload);
        if (nested && method === "Target.attachedToTarget") conn.childParents.set(nested, sourceSessionId);
        else if (nested && method === "Target.detachedFromTarget") conn.childParents.delete(nested);
      }
      return;
    }
    if (method.startsWith("Runtime.")) {
      const createdContext = method === "Runtime.executionContextCreated" ? params?.context : undefined;
      const createdContextId =
        createdContext &&
        typeof createdContext === "object" &&
        "id" in createdContext &&
        typeof createdContext.id === "number"
          ? createdContext.id
          : undefined;
      const destroyedContextId =
        method === "Runtime.executionContextDestroyed" && typeof params?.executionContextId === "number"
          ? params.executionContextId
          : undefined;
      if (createdContextId !== undefined && params) tab.runtimeContexts.set(createdContextId, params);
      if (destroyedContextId !== undefined) tab.runtimeContexts.delete(destroyedContextId);
      if (method === "Runtime.executionContextsCleared") tab.runtimeContexts.clear();

      for (const conn of this.#conns.values()) {
        for (const [pageSession, ref] of conn.sessions) {
          if (ref.kind !== "page" || ref.tabKey !== tabKey) continue;
          if (destroyedContextId !== undefined) ref.runtimeContexts.delete(destroyedContextId);
          if (method === "Runtime.executionContextsCleared") ref.runtimeContexts.clear();
          // `default` 会话从未 enable Runtime 但仍收到遗留扇出；只有显式 `Runtime.disable`
          // 才静音一个会话。
          if (ref.runtimeState === "disabled") continue;
          if (createdContextId !== undefined) {
            if (ref.runtimeContexts.has(createdContextId)) continue;
            ref.runtimeContexts.add(createdContextId);
          }
          conn.socket.send(JSON.stringify({ sessionId: pageSession, method, params }));
        }
      }
      return;
    }
    // 其余根会话事件按铸造页面会话扇出。真实子目标每连接只宣布一次（在 armed
    // auto-attach 的会话上），其 detach 也发往同一会话。
    if (method === "Target.attachedToTarget" || method === "Target.detachedFromTarget") {
      const child = params?.sessionId;
      if (typeof child !== "string") return;
      for (const conn of this.#conns.values()) {
        let parent: string | undefined;
        if (method === "Target.attachedToTarget") {
          parent = conn.childTargetSessionForTab(tabKey);
          if (parent) conn.childParents.set(child, parent);
        } else {
          parent = conn.childParents.get(child);
          conn.childParents.delete(child);
        }
        if (parent) conn.socket.send(JSON.stringify({ sessionId: parent, method, params }));
      }
      return;
    }
    for (const conn of this.#conns.values()) {
      for (const pageSession of conn.sessionsForTab(tabKey, "page")) {
        conn.socket.send(JSON.stringify({ sessionId: pageSession, method, params }));
      }
    }
  }

  #onTabDetached(tabKey: string, reason: string, relayInitiated: boolean): void {
    const tab = this.#tabs.get(tabKey);
    if (!tab) return;
    // 显式来源归因来自执行 chrome.debugger.detach 的扩展，socket 换线不可能把它与用户
    // 取消混淆，也不会改动别的标签的在途 attach promise。
    if (relayInitiated) {
      // 换线 hello 可能在在途 detach 完成前观察到旧挂载。除非更新的 attach 已盖过这次
      // detach，否则对账这份过期快照。
      if (!tab.reattachedAfterDetach) tab.attached = false;
      return;
    }
    this.#log("tab detached", { tabKey, reason });
    tab.attached = false;
    tab.attaching = null;
    this.#resetRuntime(tab);
    // 只有用户在 Chrome 调试条上按「取消」才是拒绝。Chrome 在另一扩展的帧（密码管理器
    // 的内联菜单）开始加载时也会 detach：那种标签保持可领养并立即重新宣布；Chrome 拒绝
    // 的挂载仍然 ban（#ensureAttached）。
    const cancelledByUser = reason === "canceled_by_user";
    if (cancelledByUser) tab.banned = true;
    // 用户取消会释放标签的 relay 组成员资格；其余 detach 保留。
    this.#syncTabGrouping(tab);
    // relay 私有事件，先于各会话的 detach：驱动该标签的客户端由此得知是 Chrome 结束了
    // 挂载而非页面，可以重新领养而不是等在死会话上。relay 正在关闭的标签在退场时也会
    // detach（Chrome 可能先于移除报告）：不可重新领养。
    if (!tab.closing) {
      for (const conn of this.#conns.values()) {
        for (const pageSession of conn.sessionsForTab(tabKey, "page")) {
          this.#emit(conn, "ACODE.debuggerDetached", { reason }, pageSession);
        }
      }
    }
    // 在途命令的失败在事件之后释放（#forwardToTab）。
    tab.chromeDetach.resolve();
    tab.chromeDetach = deferred<void>();
    this.#retractTab(tab);
    if (!cancelledByUser && !tab.closing && this.#eligible(tab) && !tab.discarded) this.#announceTab(tab);
  }

  #onTabRemoved(tabKey: string): void {
    const tab = this.#tabs.get(tabKey);
    if (!tab) return;
    this.#retractTab(tab);
    this.#tabs.delete(tabKey);
    for (const conn of this.#conns.values()) conn.claims.delete(tabKey);
  }

  #onTabUpsert(snap: TabSnapshot, instanceId: string, opts: { silent?: boolean } = {}): void {
    const inst = this.#instances.get(instanceId);
    if (!inst) return;
    const key = tabKeyOf(inst.code, snap.tabId);
    let tab = this.#tabs.get(key);
    const becameActive = snap.active && (!tab || !tab.active || tab.windowId !== snap.windowId);
    if (!tab) {
      tab = new TabState(instanceId, inst.code, snap.tabId, snap);
      this.#tabs.set(key, tab);
    } else {
      if (tab.url !== snap.url) tab.banned = false;
      // 用户把标签拖出 relay 组是 opt-out；relay 永不和用户抢分组。
      if (tab.grouped && tab.ompGroupId !== undefined && snap.groupId !== tab.ompGroupId) {
        tab.grouped = false;
        tab.groupOptOut = true;
      }
      tab.update(snap);
      if (tab.discarded && tab.attaching && !tab.attachCancelled) {
        tab.attachGeneration++;
        tab.attachCancelled = true;
        tab.cancelAttach?.();
      }
    }
    if (becameActive) {
      for (const other of this.#tabs.values()) {
        if (other !== tab && other.instanceId === instanceId && other.windowId === snap.windowId)
          other.active = false;
      }
    }
    if (opts.silent) return;
    const eligible = this.#eligible(tab);
    this.#syncTabGrouping(tab);
    if (eligible && !tab.announced && !tab.discarded) {
      this.#announceTab(tab);
      return;
    }
    if ((!eligible || tab.discarded) && tab.announced) {
      // Puppeteer 会等已宣布目标的挂载。
      this.#retractTab(tab);
      this.#detachIfUnheld(tab.tabKey);
      return;
    }
    if (eligible && tab.announced) {
      for (const conn of this.#conns.values()) {
        if (!conn.discover) continue;
        this.#emit(conn, "Target.targetInfoChanged", { targetInfo: this.#tabInfo(tab, tab.attached) });
        this.#emit(conn, "Target.targetInfoChanged", { targetInfo: this.#pageInfo(tab, tab.attached) });
      }
    }
  }

  /** 向处于发现态的连接宣布未宣布的标签，并为自动挂载者挂载它。 */
  #announceTab(tab: TabState): void {
    tab.announced = true;
    for (const conn of this.#conns.values()) {
      if (!conn.discover) continue;
      this.#emit(conn, "Target.targetCreated", { targetInfo: this.#tabInfo(tab, tab.attached) });
      this.#emit(conn, "Target.targetCreated", { targetInfo: this.#pageInfo(tab, tab.attached) });
    }
    this.#attachForAutoAttach(tab);
  }

  #attachForAutoAttach(tab: TabState): void {
    let hasAutoAttach = false;
    for (const conn of this.#conns.values()) {
      if (conn.autoAttach) {
        hasAutoAttach = true;
        break;
      }
    }
    if (!hasAutoAttach) return;
    void this.#ensureAttached(tab, { retryAfterDiscard: true }).then(ok => {
      if (!ok) {
        // 被拒的挂载把标签 ban 到 URL 变化。把宣布一并撤回，否则 URL 变化发现标签已
        // 宣布，就既不宣布也不再挂载。
        if (tab.banned && tab.announced && this.#tabs.get(tab.tabKey) === tab) this.#retractTab(tab);
        return;
      }
      if (tab.discarded || !this.#eligible(tab) || this.#tabs.get(tab.tabKey) !== tab) {
        this.#retractTab(tab);
        this.#detachIfUnheld(tab.tabKey);
        return;
      }
      for (const conn of this.#conns.values()) {
        if (conn.autoAttach) this.#emitTabAttached(conn, tab);
      }
    });
  }

  // ---- 标签分组 ----------------------------------------------------------------

  /** 标签属于 relay 组的条件：被认领、可挂载、非 pinned、未被用户 opt-out、不在用户自己的组里。 */
  #groupWorthy(tab: TabState): boolean {
    if (!this.#claimed(tab.tabKey) || !this.#eligible(tab) || tab.pinned || tab.groupOptOut) return false;
    return tab.grouped || tab.groupId === -1;
  }

  /** 重新归组每个被认领的标签（扩展 hello / 重连时）。 */
  #syncGrouping(): void {
    if (!this.#group) return;
    const worthy = [...this.#tabs.values()].filter(tab => this.#groupWorthy(tab) && !tab.grouped && !tab.grouping);
    if (worthy.length > 0) this.#requestGroup(worthy);
  }

  /** 标签生命周期事件后对账单个标签的组成员资格。 */
  #syncTabGrouping(tab: TabState): void {
    if (!this.#group) return;
    if (this.#groupWorthy(tab)) {
      if (!tab.grouped && !tab.grouping) this.#requestGroup([tab]);
      return;
    }
    if (tab.grouped) {
      tab.grouped = false;
      tab.ompGroupId = undefined;
      void this.#rpc({ op: "ungroup", tabIds: [tab.tabId] }, this.#instanceFor(tab)).catch(() => {});
    }
  }

  /**
   * 标签入队并串行 drain。重叠的组 RPC 会与扩展非原子的 查询→建组→改名 序列竞态，
   * 在同一窗口铸出重复的同名组，所以任意时刻最多一个组 RPC 在途。
   */
  #requestGroup(tabs: TabState[]): void {
    if (!this.#group) return;
    for (const tab of tabs) {
      tab.grouping = true;
      this.#groupQueue.push(tab);
    }
    if (!this.#groupDraining) void this.#drainGroupQueue();
  }

  async #drainGroupQueue(): Promise<void> {
    const group = this.#group;
    if (!group) return;
    this.#groupDraining = true;
    try {
      while (this.#groupQueue.length > 0) {
        const batch = this.#groupQueue.splice(0);
        // 组 RPC 以 chrome tabId 在一个浏览器实例内寻址，混合批次按实例拆分。
        const byInstance = new Map<string, TabState[]>();
        for (const tab of batch) {
          const tabs = byInstance.get(tab.instanceId);
          if (tabs) tabs.push(tab);
          else byInstance.set(tab.instanceId, [tab]);
        }
        for (const [instanceId, tabs] of byInstance) {
          const inst = this.#instances.get(instanceId);
          if (!inst?.socket) {
            for (const tab of tabs) tab.grouping = false;
            continue;
          }
          const tabIds = tabs.map(tab => tab.tabId);
          try {
            const result = await this.#rpc({ op: "group", tabIds, title: group.title, color: group.color }, inst);
            // 扩展应答 { grouped: { [tabId]: groupId } }；逐条校验。
            const grouped: Record<string, unknown> =
              result &&
              typeof result === "object" &&
              "grouped" in result &&
              result.grouped &&
              typeof result.grouped === "object"
                ? (result.grouped as Record<string, unknown>)
                : {};
            for (const tab of tabs) {
              const groupId = grouped[String(tab.tabId)];
              if (typeof groupId !== "number") continue;
              tab.grouped = true;
              tab.ompGroupId = groupId;
            }
            this.#log("grouped tabs", { instanceId, tabIds, grouped });
          } catch (err) {
            this.#log("tab grouping failed", { error: err instanceof Error ? err.message : String(err) });
          } finally {
            for (const tab of tabs) tab.grouping = false;
          }
        }
      }
    } finally {
      this.#groupDraining = false;
    }
  }

  /** 把标签从每条下游连接上撤下（关闭、脱离或已不可挂载）。 */
  #retractTab(tab: TabState): void {
    this.#forgetChildren(tab);
    for (const conn of this.#conns.values()) {
      const tabSessions = conn.sessionsForTab(tab.tabKey, "tab");
      for (const pageSession of conn.sessionsForTab(tab.tabKey, "page")) {
        conn.sessions.delete(pageSession);
        this.#emit(
          conn,
          "Target.detachedFromTarget",
          { sessionId: pageSession, targetId: pageTargetIdFromKey(tab.tabKey) },
          tabSessions[0],
        );
      }
      for (const tabSession of tabSessions) {
        conn.sessions.delete(tabSession);
        this.#emit(conn, "Target.detachedFromTarget", {
          sessionId: tabSession,
          targetId: tabTargetIdFromKey(tab.tabKey),
        });
      }
      if (conn.discover && tab.announced) {
        this.#emit(conn, "Target.targetDestroyed", { targetId: pageTargetIdFromKey(tab.tabKey) });
        this.#emit(conn, "Target.targetDestroyed", { targetId: tabTargetIdFromKey(tab.tabKey) });
      }
    }
    tab.announced = false;
  }

  // ---- 会话与挂载记账 ----------------------------------------------------------

  #mintSession(conn: CdpConnection, kind: "tab" | "page", tab: TabState): string {
    const sessionId = `S${kind === "tab" ? "T" : "P"}${tab.tabId}.${conn.id}.${++this.#sessionSeq}`;
    conn.sessions.set(sessionId, {
      kind,
      tabKey: tab.tabKey,
      tabId: tab.tabId,
      runtimeState: "default",
      runtimeContexts: new Set(),
      runtimeEnabling: null,
      runtimeEpoch: 0,
      autoAttach: false,
      interceptsFileChooser: false,
    });
    return sessionId;
  }

  #releaseSession(conn: CdpConnection, sessionId: string, parentSessionId: string | undefined): void {
    const ref = conn.sessions.get(sessionId);
    if (!ref) return;
    conn.sessions.delete(sessionId);
    if (ref.interceptsFileChooser) this.#releaseFileChooserInterception(ref.tabKey);
    const targetId = ref.kind === "tab" ? tabTargetIdFromKey(ref.tabKey) : pageTargetIdFromKey(ref.tabKey);
    this.#emit(conn, "Target.detachedFromTarget", { sessionId, targetId }, parentSessionId);
    // 最后一个会话的显式释放必须连带丢掉挂载，否则挂载比所有下游会话都长寿：信息条
    // 挂着，关掉它会把标签 ban 掉整个时代。
    this.#detachIfUnheld(ref.tabKey);
  }

  /**
   * 没有下游会话持有标签时释放它的 chrome.debugger 挂载。长驻 registry 连接仍持有一个
   * 时保持惰性。
   */
  #detachIfUnheld(tabKey: string): void {
    if (this.#sessionHolders(tabKey).length > 0) return;
    const tab = this.#tabs.get(tabKey);
    if (!tab?.attached) return;
    tab.attached = false;
    this.#resetRuntime(tab);
    this.#forgetChildren(tab);
    tab.reattachedAfterDetach = false;
    const done = this.#rpc({ op: "detach", tabId: tab.tabId }, this.#instanceFor(tab))
      .then(() => {})
      .catch(() => {})
      .finally(() => {
        if (tab.detaching === done) tab.detaching = null;
      });
    tab.detaching = done;
  }

  #resetRuntime(tab: TabState): void {
    tab.runtimeContexts.clear();
    tab.rootRuntimeEnabled = false;
    tab.rootRuntimeEnabling = null;
    tab.runtimeGeneration++;
  }

  /**
   * 丢弃标签的真实子会话——它们随 debugger 挂载一起结束——并向每个被告知子目标的连接
   * 发 detach；嵌套子目标先走，此时其父还已知。
   */
  #forgetChildren(tab: TabState): void {
    for (const child of [...tab.realSessions.keys()].reverse()) {
      this.#realSessionTabs.delete(child);
      for (const conn of this.#conns.values()) {
        const parent = conn.childParents.get(child);
        if (parent === undefined) continue;
        conn.childParents.delete(child);
        this.#emit(conn, "Target.detachedFromTarget", { sessionId: child }, parent);
      }
    }
    tab.realSessions.clear();
  }

  /** 当前在某标签上持有任意会话的连接。 */
  #sessionHolders(tabKey: string): CdpConnection[] {
    const out: CdpConnection[] = [];
    for (const conn of this.#conns.values()) {
      if (conn.sessionsForTab(tabKey).length > 0) out.push(conn);
    }
    return out;
  }

  /** 一个标签的所有活动会话（跨连接）中是否有任何一个开着文件选择器拦截。 */
  #interceptsFileChooser(tabKey: string): boolean {
    for (const conn of this.#conns.values()) {
      for (const ref of conn.sessions.values()) {
        if (ref.tabKey === tabKey && ref.interceptsFileChooser) return true;
      }
    }
    return false;
  }

  /**
   * 没有任何活动会话再需要拦截时把它关掉：一个没有显式关闭它就消失的会话（上传中被
   * 杀的 worker）否则会让共享挂载吞掉之后的每一个文件选择器。
   */
  #releaseFileChooserInterception(tabKey: string): void {
    void this.#serializeInterception(tabKey, async () => {
      if (this.#interceptsFileChooser(tabKey)) return;
      const tab = this.#tabs.get(tabKey);
      const inst = tab?.attached ? this.#instances.get(tab.instanceId) : undefined;
      if (!tab || !inst) return;
      const params = { enabled: false };
      await this.#rpc(
        { op: "send", tabId: tab.tabId, method: "Page.setInterceptFileChooserDialog", params },
        inst,
      ).catch(() => {});
    });
  }

  /**
   * 一个标签的拦截切换一次跑一个，每个切换发送它运行时标签的实际标签级状态。扩展独立
   * 地发起 RPC，重叠的切换可能乱序落定：一个失败切换的回滚会把状态恢复成另一个切换
   * 已经改过的样子。
   */
  #serializeInterception(tabKey: string, run: () => Promise<void>): Promise<void> {
    const pending = this.#interceptionTransitions.get(tabKey);
    const result = pending ? pending.then(run) : run();
    const tail = result.catch(() => {});
    this.#interceptionTransitions.set(tabKey, tail);
    void tail.then(() => {
      if (this.#interceptionTransitions.get(tabKey) === tail) this.#interceptionTransitions.delete(tabKey);
    });
    return result;
  }

  #emitTabAttached(conn: CdpConnection, tab: TabState): void {
    if (conn.sessionsForTab(tab.tabKey, "tab").length > 0) return;
    const sessionId = this.#mintSession(conn, "tab", tab);
    this.#emit(conn, "Target.attachedToTarget", {
      sessionId,
      targetInfo: this.#tabInfo(tab, true),
      waitingForDebugger: false,
    });
  }

  async #ensureAttached(tab: TabState, opts: { retryAfterDiscard?: boolean } = {}): Promise<boolean> {
    if (tab.discarded) return false;
    // 扩展先发出 detach 回声再 resolve RPC。等待它，防止替换挂载与任一操作竞速。
    while (tab.detaching) await tab.detaching;
    if (tab.discarded) return false;
    if (tab.attached) return true;
    if (!this.#eligible(tab)) return false;
    const inst = this.#instances.get(tab.instanceId);
    if (!inst?.socket) return false;
    if (tab.attaching) {
      if (tab.attachCancelled && opts.retryAfterDiscard) tab.retryAttachAfterDiscard = true;
      return await tab.attaching;
    }
    const generation = tab.attachGeneration;
    const cancelled = deferred<boolean>();
    const request = this.#rpc({ op: "attach", tabId: tab.tabId }, inst)
      .then(() => {
        tab.attached = true;
        tab.reattachedAfterDetach = true;
        if (tab.discarded) this.#detachIfUnheld(tab.tabKey);
        return !tab.discarded;
      })
      .catch(err => {
        this.#log("attach failed", {
          tabKey: tab.tabKey,
          url: tab.url,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!(err instanceof ExtensionReplacedError) && generation === tab.attachGeneration) tab.banned = true;
        return false;
      })
      .finally(() => {
        if (tab.attaching === attempt) {
          tab.attaching = null;
          tab.cancelAttach = null;
          tab.attachCancelled = false;
        }
        const retry = tab.retryAttachAfterDiscard;
        tab.retryAttachAfterDiscard = false;
        if (retry && !tab.discarded) this.#attachForAutoAttach(tab);
      });
    // 被丢弃标签的等待立即停，但不丢扩展 RPC 的迟到结果。
    const attempt = Promise.race([request, cancelled.promise]);
    tab.attaching = attempt;
    tab.cancelAttach = () => cancelled.resolve(false);
    return await attempt;
  }

  #eligible(tab: TabState): boolean {
    if (tab.banned) return false;
    const instance = this.#instances.get(tab.instanceId);
    if (!instance?.socket || instance.info?.relayProtocol !== RELAY_PROTOCOL_VERSION) return false;
    if (!tab.url) return true;
    return !INELIGIBLE_URL.test(tab.url);
  }

  #tabInfo(tab: TabState, attached: boolean): TargetInfo {
    return {
      targetId: tabTargetIdFromKey(tab.tabKey),
      type: "tab",
      title: tab.title,
      url: tab.url || "about:blank",
      attached,
      canAccessOpener: false,
    };
  }

  #pageInfo(tab: TabState, attached: boolean): TargetInfo {
    return {
      targetId: pageTargetIdFromKey(tab.tabKey),
      type: "page",
      title: tab.title,
      url: tab.url || "about:blank",
      attached,
      canAccessOpener: false,
    };
  }

  // ---- 管道 -------------------------------------------------------------------

  #reply(conn: CdpConnection, msg: CdpCommand, result: Record<string, unknown>): void {
    conn.socket.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, result }));
  }

  #replyError(conn: CdpConnection, msg: CdpCommand, message: string, code = CDP_ERROR_SERVER): void {
    conn.socket.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, error: { code, message } }));
  }

  #emit(conn: CdpConnection, method: string, params: Record<string, unknown>, sessionId?: string): void {
    conn.socket.send(JSON.stringify({ sessionId, method, params }));
  }

  /** 标签所属的扩展实例；浏览器消失即抛。 */
  #instanceFor(tab: TabState): ExtInstance {
    const inst = this.#instances.get(tab.instanceId);
    if (!inst) throw new Error("relay extension is not connected");
    return inst;
  }

  #rpc(req: RelayRpcRequest, inst: ExtInstance, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
    if (!inst.socket) return Promise.reject(new Error("relay extension is not connected"));
    const id = ++this.#rpcSeq;
    const pending = deferred<unknown>();
    const timer = setTimeout(() => {
      this.#pendingRpc.delete(`${inst.instanceId}:${id}`);
      pending.reject(new Error(`extension rpc '${req.op}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    this.#pendingRpc.set(`${inst.instanceId}:${id}`, {
      resolve: pending.resolve,
      reject: pending.reject,
      timer,
    });
    inst.socket.send(JSON.stringify({ t: "rpc", id, ...req } satisfies RelayToExtMessage));
    return pending.promise;
  }
}
