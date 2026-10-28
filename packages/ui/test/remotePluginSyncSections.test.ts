// RemotePluginSyncDialog 批次 2（SelectionList / ProgressList / ResultList 三组件外迁）的
// **接缝内测试**。形态对照 assistantTextActionsRender.test.ts：renderToStaticMarkup +
// createElement，无 jsdom。断言三组件的渲染契约与关键交互标记：
//   - SelectionList：勾选态/禁用态/已存在徽章/选项汇总行/marketplace 徽章；
//   - ProgressList：状态徽章/stop 按钮可点性/日志触发器/错误行/路径行；
//   - ResultList：empty 态/逐项渲染/状态徽章/错误详情/路径回退。
// 全部 fixture 走 remotePluginSyncModel 的构建 helper（不手拼 row），守护拆出的组件
// 仍走同一数据形状。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ACodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { getLocaleMessagesResource } from "../src/i18n/localeMessages.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import {
  buildRemotePluginSyncRowsForCandidates,
  type RemotePluginSyncCandidate,
  type RemotePluginSyncProgressView,
  type RemotePluginSyncResultItem,
  type RemotePluginSyncRow,
  type RemotePluginSyncRunResult,
} from "../src/settings/remote-plugin-sync/remotePluginSyncModel.js";
import { RemotePluginSyncSelectionList } from "../src/settings/remote-plugin-sync/SelectionList.js";
import { RemotePluginSyncProgressList } from "../src/settings/remote-plugin-sync/ProgressList.js";
import { RemotePluginSyncResultList } from "../src/settings/remote-plugin-sync/ResultList.js";

// 词典是懒加载资源；renderToStaticMarkup 不支持异步 suspend，先预热 zh-CN。
test.before(async () => {
  await getLocaleMessagesResource("zh-CN").promise;
});

const render = (node: React.ReactNode): string =>
  renderToStaticMarkup(
    createElement(
      ACodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(TooltipProvider, null, node),
    ),
  );

function makeCandidate(overrides: Partial<RemotePluginSyncCandidate> = {}): RemotePluginSyncCandidate {
  return {
    id: "inline:demo",
    kind: "inline",
    name: "Demo Plugin",
    pluginId: "demo-plugin",
    marketplace: "inline",
    enabled: true,
    componentTypes: ["commands"],
    ...overrides,
  };
}

function makeRow(overrides: {
  candidate?: Partial<RemotePluginSyncCandidate>;
  exists?: boolean;
  path?: string;
  reason?: "samePluginId" | "targetExists";
  remoteMarketplaceExists?: boolean;
}): RemotePluginSyncRow {
  const candidate = makeCandidate(overrides.candidate);
  const [row] = buildRemotePluginSyncRowsForCandidates(
    [candidate],
    [
      {
        candidateId: candidate.id,
        exists: overrides.exists ?? false,
        ...(overrides.path ? { path: overrides.path } : {}),
        ...(overrides.reason ? { reason: overrides.reason } : {}),
        ...(overrides.remoteMarketplaceExists !== undefined
          ? { remoteMarketplaceExists: overrides.remoteMarketplaceExists }
          : {}),
      },
    ],
  );
  if (!row) {
    throw new Error("fixture row was not built");
  }
  return row;
}

// ────────────────────────────────────────────────────────────────────────────
// SelectionList
// ────────────────────────────────────────────────────────────────────────────

test("SelectionList：空 rows 渲染默认 empty 文案", () => {
  const html = render(
    createElement(RemotePluginSyncSelectionList, {
      rows: [],
      selectedIds: new Set<string>(),
      onToggle: () => undefined,
    }),
  );
  assert.match(html, /没有可同步到 SSH 的本地 Plugins/);
});

test("SelectionList：emptyMessageId 覆盖 empty 文案", () => {
  const html = render(
    createElement(RemotePluginSyncSelectionList, {
      rows: [],
      selectedIds: new Set<string>(),
      emptyMessageId: "settings.plugins.remoteSync.filteredEmpty",
      onToggle: () => undefined,
    }),
  );
  assert.match(html, /本地 Plugins 均已存在于远端/);
});

test("SelectionList：远端已存在行禁用 checkbox 且不计入选中", () => {
  const row = makeRow({ exists: true, reason: "samePluginId" });
  const html = render(
    createElement(RemotePluginSyncSelectionList, {
      rows: [row],
      selectedIds: new Set([row.candidate.id]),
      onToggle: () => undefined,
    }),
  );
  // exists 行的 checkbox 必须 disabled，且即便 selectedIds 含其 id 也不视为 selected。
  assert.match(html, /aria-labelledby="remote-plugin-sync-inline:demo-label"[^>]*disabled/);
  assert.doesNotMatch(html, /checked=""/);
  assert.match(html, /远端已存在/);
});

test("SelectionList：未存在行渲染 name/version/componentTypes/marketplace 徽章", () => {
  const row = makeRow({
    candidate: {
      version: "1.2.3",
      componentTypes: ["commands", "hooks"],
      marketplace: "inline",
      description: "A demo plugin",
      path: "/tmp/demo",
    },
  });
  const html = render(
    createElement(RemotePluginSyncSelectionList, {
      rows: [row],
      selectedIds: new Set([row.candidate.id]),
      onToggle: () => undefined,
    }),
  );
  assert.match(html, /Demo Plugin/);
  assert.match(html, /1\.2\.3/);
  assert.match(html, /commands/);
  assert.match(html, /hooks/);
  assert.match(html, /inline/);
  assert.match(html, /A demo plugin/);
  assert.match(html, /\/tmp\/demo/);
  // selected 行的 checkbox 必须 checked
  assert.match(html, /checked=""/);
});

test("SelectionList：marketplace 行展示 marketplace id 而非 inline 字样", () => {
  const row = makeRow({
    candidate: {
      id: "marketplace:demo",
      kind: "marketplace",
      marketplace: "acode-official",
    },
  });
  const html = render(
    createElement(RemotePluginSyncSelectionList, {
      rows: [row],
      selectedIds: new Set(),
      onToggle: () => undefined,
    }),
  );
  assert.match(html, /acode-official/);
});

test("SelectionList：optionsSummary 显示 syncable/manual 计数", () => {
  const row = makeRow({
    candidate: {
      pluginOptions: {
        configuredOptions: {
          portable: "yes",
          manual: "no",
        },
        userConfig: {
          portable: { type: "string" },
          manual: { type: "file" },
        },
      },
    },
  });
  const html = render(
    createElement(RemotePluginSyncSelectionList, {
      rows: [row],
      selectedIds: new Set(),
      onToggle: () => undefined,
    }),
  );
  // i18n: "配置：{syncable} 项会尝试同步，{manual} 项需在远端手动配置"
  assert.match(html, /配置：/);
  assert.match(html, /会尝试同步/);
  assert.match(html, /需在远端手动配置/);
});

// ────────────────────────────────────────────────────────────────────────────
// ProgressList
// ────────────────────────────────────────────────────────────────────────────

test("ProgressList：空 rows 渲染 resultEmpty 文案", () => {
  const html = render(
    createElement(RemotePluginSyncProgressList, {
      progressById: new Map(),
      rows: [],
      onStop: () => undefined,
    }),
  );
  assert.match(html, /暂无 Plugin 同步结果/);
});

test("ProgressList：queued/syncing 状态渲染 stop 按钮，synced/failed 不渲染", () => {
  const syncingRow = makeRow({ candidate: { id: "inline:a", name: "A" } });
  const syncedRow = makeRow({ candidate: { id: "inline:b", name: "B" } });
  const progressById = new Map<string, RemotePluginSyncProgressView>([
    ["inline:a", { logs: ["start"], status: "syncing" }],
    [
      "inline:b",
      {
        logs: ["done"],
        status: "synced",
        result: {
          name: "B",
          pluginId: "b",
          directoryName: "b",
          status: "synced",
        },
      },
    ],
  ]);
  const html = render(
    createElement(RemotePluginSyncProgressList, {
      progressById,
      rows: [syncingRow, syncedRow],
      onStop: () => undefined,
    }),
  );
  // syncing 行有 aria-label="停止同步"；synced 行无。
  const stops = html.match(/aria-label="停止同步"/g) ?? [];
  assert.equal(stops.length, 1);
  // 状态徽章文案
  assert.match(html, /已同步/);
});

test("ProgressList：无 progress 记录时回退到 queued 默认视图", () => {
  const row = makeRow({});
  const html = render(
    createElement(RemotePluginSyncProgressList, {
      progressById: new Map(),
      rows: [row],
      onStop: () => undefined,
    }),
  );
  // 状态徽章 queued 文案
  assert.match(html, /等待中/);
});

test("ProgressList：result.error 优先于 path 渲染为错误行", () => {
  const row = makeRow({ candidate: { path: "/should/not/show" } });
  const progressById = new Map<string, RemotePluginSyncProgressView>([
    [
      row.candidate.id,
      {
        logs: ["boom"],
        status: "failed",
        result: {
          name: row.candidate.name,
          pluginId: row.candidate.pluginId,
          directoryName: "demo",
          status: "failed",
          error: "boom happened",
        },
      },
    ],
  ]);
  const html = render(
    createElement(RemotePluginSyncProgressList, {
      progressById,
      rows: [row],
      onStop: () => undefined,
    }),
  );
  assert.match(html, /boom happened/);
  assert.doesNotMatch(html, /\/should\/not\/show/);
  assert.match(html, /失败/);
});

test("ProgressList：无 error 且无 path 时不渲染 meta 段", () => {
  const row = makeRow({});
  const progressById = new Map<string, RemotePluginSyncProgressView>([
    [row.candidate.id, { logs: [], status: "queued" }],
  ]);
  const html = render(
    createElement(RemotePluginSyncProgressList, {
      progressById,
      rows: [row],
      onStop: () => undefined,
    }),
  );
  // 仍渲染候选名称
  assert.match(html, /Demo Plugin/);
  // 不出现 text-destructive 错误行
  assert.doesNotMatch(html, /text-destructive/);
});

// ────────────────────────────────────────────────────────────────────────────
// ResultList
// ────────────────────────────────────────────────────────────────────────────

test("ResultList：result=null 渲染 resultEmpty 文案", () => {
  const html = render(createElement(RemotePluginSyncResultList, { result: null }));
  assert.match(html, /暂无 Plugin 同步结果/);
});

test("ResultList：result.results 为空也渲染 resultEmpty 文案", () => {
  const result: RemotePluginSyncRunResult = { results: [] };
  const html = render(createElement(RemotePluginSyncResultList, { result }));
  assert.match(html, /暂无 Plugin 同步结果/);
});

test("ResultList：渲染成功/失败/停止三态徽章", () => {
  const items: RemotePluginSyncResultItem[] = [
    { name: "A", pluginId: "a", directoryName: "a", status: "synced" },
    {
      name: "B",
      pluginId: "b",
      directoryName: "b",
      status: "failed",
      error: "network unreachable",
    },
    { name: "C", pluginId: "c", directoryName: "c", status: "stopped" },
  ];
  const html = render(
    createElement(RemotePluginSyncResultList, { result: { results: items } }),
  );
  assert.match(html, /已同步/);
  assert.match(html, /失败/);
  assert.match(html, /已停止/);
  assert.match(html, /network unreachable/);
});

test("ResultList：error 优先于 path，无 error 时回退渲染 path", () => {
  const withError: RemotePluginSyncResultItem = {
    name: "HasError",
    pluginId: "he",
    directoryName: "he",
    status: "failed",
    error: "fatal",
    path: "/should/not/appear",
  };
  const withPath: RemotePluginSyncResultItem = {
    name: "OnlyPath",
    pluginId: "op",
    directoryName: "op",
    status: "synced",
    path: "/opt/plugins/op",
  };
  const html = render(
    createElement(RemotePluginSyncResultList, {
      result: { results: [withError, withPath] },
    }),
  );
  assert.match(html, /fatal/);
  assert.doesNotMatch(html, /\/should\/not\/appear/);
  assert.match(html, /\/opt\/plugins\/op/);
});

test("ResultList：每条目 key 包含 pluginId-directoryName-status 三元组（重名不冲突）", () => {
  const items: RemotePluginSyncResultItem[] = [
    { name: "Same", pluginId: "p1", directoryName: "d", status: "synced" },
    { name: "Same", pluginId: "p2", directoryName: "d", status: "failed" },
  ];
  // 同名同 directoryName 但 pluginId/status 不同——不应触发 React key 冲突。
  const html = render(
    createElement(RemotePluginSyncResultList, { result: { results: items } }),
  );
  // 两条都渲染出来
  const matches = html.match(/>Same</g) ?? [];
  assert.equal(matches.length, 2);
});
