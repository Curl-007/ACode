// PluginsSection 批次 4 helper 外迁（PluginListRows / PluginUnavailableComputerUseRow）的
// 接缝内渲染契约测试。形态对照 remotePluginSyncSections.test.ts：renderToStaticMarkup +
// createElement，无 jsdom。
// 两点环境适配（不改变被测对象）：
//   1. PluginListRows 链路上 PluginIcon → pluginIconSource 静态 import .png 资源，
//      node --import tsx 无法加载（ERR_UNKNOWN_FILE_EXTENSION）；用 module.registerHooks
//      把 .png 重定向到 data: 空模块（进程内生效，node --test 每个测试文件独立进程，
//      不影响其他测试）。PluginListRows 因此走 test.before 里的动态 import。
//   2. 行内「更多」菜单是 radix DropdownMenu：Content 走 Portal 且仅打开时挂载，静态 SSR
//      只渲染 Trigger。「missing packageStatus 不渲染菜单」由 Trigger（aria-label=
//      common.more「更多」）有无钉住；「update 菜单项按 canUpdatePluginItem 出现/隐藏」
//      改由同谓词（canUpdatePluginItem）且静态渲染的行内 PluginStoreUpdateButton /
//      PluginStoreUpdateBadge 钉住。
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ACodeInstalledPluginSummary,
  ACodePluginInfo,
  ACodePluginScope,
} from "@acode/shared";

import { ACodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { getLocaleMessagesResource } from "../src/i18n/localeMessages.js";
import type { PluginStoreActions } from "../src/settings/PluginStoreCard.js";
import type { ComputerUseAvailability } from "../src/settings/computerUseAvailability.js";
import type { StorePluginItem } from "../src/settings/pluginStoreListing.js";
import type { PluginListRows as PluginListRowsComponent } from "../src/settings/plugins/PluginListRows.js";
import { PluginUnavailableComputerUseRow } from "../src/settings/plugins/PluginUnavailableComputerUseRow.js";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".png")) {
      return { url: "data:text/javascript,export default ''", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

let PluginListRows: typeof PluginListRowsComponent;

// 词典是懒加载资源；renderToStaticMarkup 不支持异步 suspend，先预热 zh-CN。
test.before(async () => {
  await getLocaleMessagesResource("zh-CN").promise;
  // 这里必须动态 import：静态 import 会被提升，.png 链路在 registerHooks 生效前就开始加载。
  ({ PluginListRows } = await import("../src/settings/plugins/PluginListRows.js"));
});

const render = (node: React.ReactNode): string =>
  renderToStaticMarkup(createElement(ACodeIntlProvider, { initialLocale: "zh-CN" }, node));

function makePlugin(overrides: Partial<ACodePluginInfo> = {}): ACodePluginInfo {
  return {
    id: "com.acode.alpha",
    name: "alpha",
    enabled: true,
    source: "marketplace",
    marketplace: "acode-official",
    skillRootCount: 0,
    commandRootCount: 0,
    mcpServerNames: [],
    ...overrides,
  } as ACodePluginInfo;
}

function makeStoreItem(overrides: Partial<StorePluginItem> = {}): StorePluginItem {
  return {
    id: "com.acode.alpha",
    name: "alpha",
    marketplace: "acode-official",
    installed: true,
    restorable: false,
    orphaned: false,
    ...overrides,
  };
}

function makeUpdatableStoreItem(): StorePluginItem {
  return makeStoreItem({
    installedMeta: { updateStatus: "update-available" } as ACodeInstalledPluginSummary,
  });
}

function makeActions(overrides: Partial<PluginStoreActions> = {}): PluginStoreActions {
  return {
    onOpenDetail: () => {},
    onInstall: () => {},
    onUninstall: () => {},
    onSetEnabled: () => {},
    onResetConfig: () => {},
    onUpdate: () => {},
    operationId: null,
    togglingPluginId: null,
    ...overrides,
  };
}

function renderRows({
  items = [makePlugin()],
  storeItemById = new Map<string, StorePluginItem>(),
  actions = makeActions(),
  configScope = "user" as ACodePluginScope,
  operationId = null,
  togglingPluginId = null,
}: {
  items?: ACodePluginInfo[];
  storeItemById?: ReadonlyMap<string, StorePluginItem>;
  actions?: PluginStoreActions;
  configScope?: ACodePluginScope;
  operationId?: string | null;
  togglingPluginId?: string | null;
} = {}): string {
  return render(
    createElement(PluginListRows, {
      items,
      storeItemById,
      actions,
      configScope,
      operationId,
      togglingPluginId,
      locale: "zh-CN",
      onUpdatePlugin: async () => {},
      onResetPluginConfig: async () => {},
      onRequestUninstall: () => {},
    }),
  );
}

// ────────────────────────────────────────────────────────────────────────────
// PluginListRows
// ────────────────────────────────────────────────────────────────────────────

test("PluginListRows：逐项渲染 row 锚点与分隔线，无 store 条目时回退插件名", () => {
  const html = renderRows({
    items: [
      makePlugin({ id: "com.acode.alpha", name: "alpha" }),
      makePlugin({ id: "com.acode.beta", name: "beta" }),
    ],
  });
  assert.equal((html.match(/data-testid="plugin-settings-plugin-row"/g) ?? []).length, 2);
  assert.ok(html.includes('data-plugin-id="com.acode.alpha"'));
  assert.ok(html.includes('data-plugin-id="com.acode.beta"'));
  // 两行之间仅一条分隔线（index > 0 才渲染）。
  assert.equal((html.match(/h-px bg-border\/50/g) ?? []).length, 1);
  // storeItemById 未命中时 resolveManagedPluginDisplay 回退 plugin.name（展示层 title-case）。
  assert.ok(html.includes(">Alpha</span>"));
  assert.ok(html.includes(">Beta</span>"));
});

test("PluginListRows：enabled switch 默认 aria-checked/aria-busy，无 pending  spinner", () => {
  const html = renderRows();
  assert.ok(html.includes('data-testid="plugin-settings-enabled-switch"'));
  assert.ok(html.includes('aria-checked="true"'));
  assert.ok(html.includes('aria-busy="false"'));
  assert.ok(!html.includes('data-testid="plugin-settings-enabled-pending"'));
});

test("PluginListRows：togglingPluginId 命中时 switch aria-busy+disabled 且渲染 pending spinner", () => {
  const html = renderRows({ togglingPluginId: "com.acode.alpha" });
  assert.ok(html.includes('data-testid="plugin-settings-enabled-pending"'));
  assert.ok(html.includes('aria-busy="true"'));
  assert.ok(html.includes("disabled"));
});

test("PluginListRows：enabled=false 时 switch aria-checked=false", () => {
  const html = renderRows({ items: [makePlugin({ enabled: false })] });
  assert.ok(html.includes('aria-checked="false"'));
});

test("PluginListRows：packageStatus=missing 不渲染行内菜单 trigger，其余渲染", () => {
  const missing = renderRows({ items: [makePlugin({ packageStatus: "missing" })] });
  assert.ok(missing.includes('data-testid="plugin-settings-plugin-row"'));
  assert.ok(!missing.includes('aria-label="更多"'));

  const normal = renderRows();
  assert.ok(normal.includes('aria-label="更多"'));
});

test("PluginListRows：canUpdatePluginItem 决定行内更新按钮/徽标出现或隐藏", () => {
  const updatable = renderRows({
    storeItemById: new Map([["com.acode.alpha", makeUpdatableStoreItem()]]),
  });
  assert.ok(updatable.includes('data-testid="plugin-store-card-update"'));
  assert.ok(updatable.includes('data-testid="plugin-store-update-badge"'));

  // 无 installedMeta（无更新状态）→ 不渲染。
  const noMeta = renderRows({
    storeItemById: new Map([["com.acode.alpha", makeStoreItem()]]),
  });
  assert.ok(!noMeta.includes('data-testid="plugin-store-card-update"'));
  assert.ok(!noMeta.includes('data-testid="plugin-store-update-badge"'));

  // orphaned（来源已移除）即使有 updateStatus 也不渲染。
  const orphaned = renderRows({
    storeItemById: new Map([["com.acode.alpha", { ...makeUpdatableStoreItem(), orphaned: true }]]),
  });
  assert.ok(!orphaned.includes('data-testid="plugin-store-card-update"'));
  assert.ok(!orphaned.includes('data-testid="plugin-store-update-badge"'));

  // storeItemById 完全未命中 → 不渲染。
  const missingItem = renderRows();
  assert.ok(!missingItem.includes('data-testid="plugin-store-card-update"'));
});

test("PluginListRows：scope 徽标跟随 enabledSource（user/workspace/default）", () => {
  const workspace = renderRows({
    items: [makePlugin({ enabledSource: "workspace" })],
    configScope: "workspace",
  });
  assert.ok(workspace.includes('data-settings-scope="workspace"'));

  const user = renderRows({ items: [makePlugin({ enabledSource: "user" })] });
  assert.ok(user.includes('data-settings-scope="user"'));

  const fallback = renderRows({ items: [makePlugin()] });
  assert.ok(fallback.includes('data-settings-scope="default"'));
});

// ────────────────────────────────────────────────────────────────────────────
// PluginUnavailableComputerUseRow
// ────────────────────────────────────────────────────────────────────────────

function renderComputerUseRow(computerUseAvailability: ComputerUseAvailability): string {
  return render(createElement(PluginUnavailableComputerUseRow, { computerUseAvailability }));
}

test("PluginUnavailableComputerUseRow：local-linux 渲染 linux 描述文案", () => {
  const html = renderComputerUseRow({ kind: "local-linux", supported: false });
  assert.ok(html.includes("电脑控制"));
  assert.ok(html.includes("当前环境不可用"));
  assert.ok(
    html.includes(
      "Computer Use 暂不支持 Linux 桌面环境。请切换到本机 macOS 或 Windows 工作区。",
    ),
  );
  assert.ok(!html.includes("SSH、WSL、Docker"));
});

test("PluginUnavailableComputerUseRow：remote-* 渲染 remote 描述文案", () => {
  for (const kind of ["remote-ssh", "remote-wsl", "remote-docker", "remote-server"] as const) {
    const html = renderComputerUseRow({ kind, supported: false });
    assert.ok(
      html.includes(
        "Computer Use 暂不支持 SSH、WSL、Docker 或其他远端环境。请切换到本机 macOS 或 Windows 工作区。",
      ),
      `kind=${kind}`,
    );
    assert.ok(!html.includes("Linux 桌面环境"), `kind=${kind}`);
  }
});
