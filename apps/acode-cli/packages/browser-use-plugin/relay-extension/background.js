// Ported from oh-my-pi (MIT) — packages/browser-relay/extension/background.ts,
// Copyright (c) 2025 Mario Zechner & Stencil Labs. 降解为纯 JS module service worker；
// omp 品牌统一改为 ACode（组名、alarm 名、日志文案）。
/**
 * ACode Browser Relay — MV3 service worker。
 *
 * 哑管道设计：全部 CDP 编排都在 relay 服务端。本 worker 只做三件事：
 * (1) 维持到 relay 的 websocket；(2) 对 `chrome.debugger`/`chrome.tabs` 执行其 RPC；
 * (3) 把标签与 debugger 事件流回去。
 *
 * Service worker 生命周期：连接期间，打开的 websocket 加周期 ping 让 worker 存活
 * （Chrome 116+）；Chrome 回收 worker 后由 chrome.alarms 周期唤醒并重拨。
 */
import { ownedDebuggerTabs } from "./debugger-ownership.js";

const DEFAULT_PORT = 9224;
const PING_INTERVAL_MS = 20_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;
/** 与 relay 侧 protocol.ts 的 RELAY_PROTOCOL_VERSION 保持一致。 */
const RELAY_PROTOCOL_VERSION = 1;

let ws = null;
let reconnectDelay = RECONNECT_MIN_MS;
let pingTimer = null;
const relayInitiatedDetachTabs = new Set();

/**
 * 稳定的每安装浏览器身份，持久化在 `chrome.storage.local`，随每次 hello 上报。relay 按
 * 实例隔离标签注册表：多个浏览器可共用一个 relay，service worker 重启沿用本浏览器的
 * 标签注册表，而不是顶掉别的浏览器的连接。
 */
let instanceId = null;
async function ensureInstanceId() {
	if (instanceId) return instanceId;
	const key = "relayInstanceId";
	const stored = await chrome.storage.local.get({ [key]: "" });
	const existing = stored[key];
	instanceId = typeof existing === "string" && existing.length > 0 ? existing : crypto.randomUUID();
	await chrome.storage.local.set({ [key]: instanceId });
	return instanceId;
}

async function loadSettings() {
	const stored = await chrome.storage.local.get({ port: DEFAULT_PORT, token: "" });
	const port = Number(stored.port);
	return {
		port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT,
		token: typeof stored.token === "string" ? stored.token : "",
	};
}

function snapshot(tab) {
	if (tab.id === undefined) return null;
	return {
		tabId: tab.id,
		url: tab.url ?? tab.pendingUrl ?? "",
		title: tab.title ?? "",
		active: tab.active,
		discarded: tab.discarded === true,
		windowId: tab.windowId,
		pinned: tab.pinned,
		groupId: tab.groupId,
	};
}

/** relay 标签组的标题；镜像到 session storage，service worker 重启后仍可解散组。 */
let relayGroupTitle = null;

/**
 * 组操作串行化。Chrome 的 query→group→set-title 序列不是原子的：两个并发执行都会
 * 错过还没改名的组，在同一窗口铸出重复的同名组。
 */
let groupOps = Promise.resolve();
function enqueueGroupOp(fn) {
	const result = groupOps.then(fn, fn);
	groupOps = result.catch(() => {});
	return result;
}

/** 把标签移入按窗口的 relay 组，按标题复用或创建。 */
async function groupTabs(tabIds, title, color) {
	relayGroupTitle = title;
	void chrome.storage.session.set({ relayGroupTitle: title });
	const byWindow = new Map();
	for (const tabId of tabIds) {
		try {
			const tab = await chrome.tabs.get(tabId);
			// 分组会静默解 pin；pinned 标签绝不动。
			if (tab.pinned || tab.id === undefined) continue;
			const bucket = byWindow.get(tab.windowId) ?? [];
			bucket.push(tab.id);
			byWindow.set(tab.windowId, bucket);
		} catch {
			// 标签已关闭。
		}
	}
	const grouped = {};
	for (const [windowId, ids] of byWindow) {
		const existing = await chrome.tabGroups.query({ title, windowId });
		let groupId;
		if (existing[0]) {
			groupId = existing[0].id;
			// 治愈旧竞态留下的重复同名组。
			for (const dupe of existing.slice(1)) {
				const dupeTabs = await chrome.tabs.query({ groupId: dupe.id });
				const dupeIds = dupeTabs.map((tab) => tab.id).filter((id) => id !== undefined);
				if (dupeIds.length > 0) await chrome.tabs.group({ tabIds: dupeIds, groupId });
			}
			await chrome.tabs.group({ tabIds: ids, groupId });
		} else {
			groupId = await chrome.tabs.group({ tabIds: ids });
		}
		await chrome.tabGroups.update(groupId, { title, color });
		for (const id of ids) grouped[String(id)] = groupId;
	}
	return { grouped };
}

/** 解散所有 relay 组（relay 断开或要求释放标签时）。 */
async function restoreGroups() {
	if (!relayGroupTitle) {
		// 上次组操作后 service worker 重启过；从 session storage 恢复标题。
		const stored = await chrome.storage.session.get({ relayGroupTitle: "" }).catch(() => ({ relayGroupTitle: "" }));
		relayGroupTitle = typeof stored.relayGroupTitle === "string" && stored.relayGroupTitle ? stored.relayGroupTitle : null;
	}
	if (!relayGroupTitle) return;
	const groups = await chrome.tabGroups.query({ title: relayGroupTitle }).catch(() => []);
	for (const group of groups) {
		const tabs = await chrome.tabs.query({ groupId: group.id }).catch(() => []);
		const ids = tabs.map((tab) => tab.id).filter((id) => id !== undefined);
		if (ids.length > 0) await chrome.tabs.ungroup(ids).catch(() => {});
	}
}

function post(msg) {
	if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function setBadge(connected) {
	try {
		await chrome.action.setBadgeText({ text: connected ? "on" : "off" });
		await chrome.action.setBadgeBackgroundColor({ color: connected ? "#1a7f37" : "#8b8b8b" });
	} catch {
		// 徽标只是外观；绝不让它打断 relay 循环。
	}
}

async function buildHello() {
	const [tabs, targets] = await Promise.all([chrome.tabs.query({}), chrome.debugger.getTargets()]);
	const snapshots = [];
	for (const tab of tabs) {
		const snap = snapshot(tab);
		if (snap) snapshots.push(snap);
	}
	// DevTools 或其他扩展挂载时 attached 也为真；只有本扩展自己的挂载才应答得了命令。
	const attachedTabIds = await ownedDebuggerTabs(targets, (tabId) =>
		chrome.debugger.sendCommand({ tabId }, "Target.getTargetInfo"),
	);
	const versionMatch = /Chrome\/[\d.]+/.exec(navigator.userAgent);
	return {
		t: "hello",
		instanceId: await ensureInstanceId(),
		userAgent: navigator.userAgent,
		browserVersion: versionMatch?.[0] ?? "Chrome/unknown",
		relayProtocol: RELAY_PROTOCOL_VERSION,
		tabs: snapshots,
		attachedTabIds,
	};
}

async function runRpc(msg) {
	switch (msg.op) {
		case "attach":
			await chrome.debugger.attach({ tabId: msg.tabId }, "1.3");
			return {};
		case "detach":
			relayInitiatedDetachTabs.add(msg.tabId);
			try {
				await chrome.debugger.detach({ tabId: msg.tabId });
				return {};
			} catch (error) {
				relayInitiatedDetachTabs.delete(msg.tabId);
				throw error;
			}
		case "send":
			return await chrome.debugger.sendCommand(
				msg.sessionId ? { tabId: msg.tabId, sessionId: msg.sessionId } : { tabId: msg.tabId },
				msg.method,
				msg.params,
			);
		case "createTab": {
			const tab = await chrome.tabs.create({ url: msg.url, active: msg.active ?? true });
			const snap = snapshot(tab);
			if (!snap) throw new Error("created tab has no id");
			return { tab: snap };
		}
		case "removeTab":
			await chrome.tabs.remove(msg.tabId);
			return {};
		case "activateTab": {
			const tab = await chrome.tabs.get(msg.tabId);
			await chrome.windows.update(tab.windowId, { focused: true });
			await chrome.tabs.update(msg.tabId, { active: true });
			return {};
		}
		case "group":
			return await enqueueGroupOp(() => groupTabs(msg.tabIds, msg.title, msg.color));
		case "ungroup":
			await enqueueGroupOp(() => chrome.tabs.ungroup(msg.tabIds).catch(() => {}));
			return {};
		default:
			throw new Error(`unknown rpc op ${String(msg.op)}`);
	}
}

function handleRelayMessage(raw) {
	let msg;
	try {
		msg = JSON.parse(raw);
	} catch {
		return;
	}
	if (msg.t === "pong") return;
	void runRpc(msg)
		.then((result) => post({ t: "rpcResult", id: msg.id, ok: true, result }))
		.catch((err) => {
			post({ t: "rpcResult", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
		});
}

function scheduleReconnect() {
	const delay = reconnectDelay;
	reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
	setTimeout(() => void connect(), delay);
}

async function connect() {
	if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
	const settings = await loadSettings();
	// token 只进拨出 URL 的查询串，绝不入日志（relay 与本扩展都不打印它）。
	const url = `ws://127.0.0.1:${settings.port}/ext${settings.token ? `?token=${encodeURIComponent(settings.token)}` : ""}`;
	const socket = new WebSocket(url);
	ws = socket;
	socket.onopen = () => {
		reconnectDelay = RECONNECT_MIN_MS;
		void setBadge(true);
		void buildHello().then((hello) => post(hello));
		if (pingTimer !== null) clearInterval(pingTimer);
		pingTimer = setInterval(() => post({ t: "ping" }), PING_INTERVAL_MS);
	};
	socket.onmessage = (event) => {
		if (typeof event.data === "string") handleRelayMessage(event.data);
	};
	socket.onclose = () => {
		if (ws !== socket) return;
		ws = null;
		if (pingTimer !== null) {
			clearInterval(pingTimer);
			pingTimer = null;
		}
		void setBadge(false);
		void restoreGroups();
		scheduleReconnect();
	};
	socket.onerror = () => {
		socket.close();
	};
}

// ---- 事件流 --------------------------------------------------------------------

chrome.debugger.onEvent.addListener((source, method, params) => {
	if (source.tabId === undefined) return;
	post({ t: "cdpEvent", tabId: source.tabId, sessionId: source.sessionId, method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
	if (source.tabId === undefined) return;
	const relayInitiated = relayInitiatedDetachTabs.delete(source.tabId);
	post({ t: "detached", tabId: source.tabId, reason, relayInitiated });
});

chrome.tabs.onCreated.addListener((tab) => {
	const snap = snapshot(tab);
	if (snap) post({ t: "tabCreated", tab: snap });
});

chrome.tabs.onUpdated.addListener((_tabId, _changeInfo, tab) => {
	const snap = snapshot(tab);
	if (snap) post({ t: "tabUpdated", tab: snap });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
	void chrome.tabs
		.get(tabId)
		.then((tab) => {
			const snap = snapshot(tab);
			if (snap) post({ t: "tabUpdated", tab: snap });
		})
		.catch(() => {
			// Chrome 应答前标签可能已关闭。
		});
});

chrome.tabs.onRemoved.addListener((tabId) => {
	post({ t: "tabRemoved", tabId });
});

// ---- 生命周期 ------------------------------------------------------------------

chrome.alarms.create("acode-relay-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === "acode-relay-keepalive") void connect();
});

chrome.storage.onChanged.addListener((_changes, areaName) => {
	if (areaName !== "local") return;
	// 设置变化：断开当前连接并用新设置重拨。
	ws?.close();
	void connect();
});

chrome.action.onClicked.addListener(() => void chrome.runtime.openOptionsPage());
chrome.runtime.onInstalled.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());

void connect();
