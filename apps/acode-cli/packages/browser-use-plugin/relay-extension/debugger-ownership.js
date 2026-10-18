// Ported from oh-my-pi (MIT) — packages/browser-relay/extension/debugger-ownership.ts,
// Copyright (c) 2025 Mario Zechner & Stencil Labs. 原样降解为纯 JS（供 Node 单测直测）。
/**
 * 只保留 probe 成功的已挂载标签：一条命令只有本扩展自己的挂载才应答得了。
 * 探针由浏览器进程应答，被阻塞或崩溃的页面不会拖慢它。
 */
export async function ownedDebuggerTabs(targets, probe) {
	const owned = await Promise.all(
		targets.map(async (target) => {
			if (!target.attached || target.tabId === undefined) return undefined;
			try {
				await probe(target.tabId);
				return target.tabId;
			} catch {
				return undefined;
			}
		}),
	);
	return owned.filter((tabId) => tabId !== undefined);
}
