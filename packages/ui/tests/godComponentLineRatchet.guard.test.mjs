import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 已登记上帝组件的**行数 ratchet**（specs/god-component-split-plan.md:78-81 的登记治理项）。
 *
 * 为什么需要：`packages/ui` 在 architecture-policy.yaml 里是 `managed: false`，而 legacy 模块的
 * max-file-lines 指纹**不含行数**（scripts/architecture/index.mjs 的 ratchet 语义：存量超限文件
 * 继续增长不产生新违规，只在「HEAD≤400 → 工作树>400」跨越时才报）。后果是 review 2026-10-26 §6
 * 记录的盲区：`AutomationEditView.tsx` 本轮 2942→2950（+8，Button a11y 迁移的良性成本）门禁**恒绿**。
 * 即「只要一个文件已经超限，它再长多少都不会让门禁变红」——上帝文件可以无限隐形膨胀。
 *
 * 本守护补上这条：一旦文件被登记进 split-plan，就把行数上限钉在登记基线，此后任何增长都红，
 * 直到该文件按批次跌破 400（届时从本表删除条目）或经评审显式上调上限并写明理由。
 *
 * **基线取值口径（2026-10-27）**：钉在实测当前行数，不是 split-plan 表头的登记时行数。
 * AutomationEditView 表头写 2,942 而实测 2,950，差的 8 行是 split-plan:70,85-87 自己记载的
 * Button a11y 迁移（裸 `<button>` → `<Button variant size>`）成本，属已合入的合法改动；
 * ratchet 的职责是冻结债务在**当前**水位、阻止继续增长，不是追溯已合入的合法工作。
 *
 * 口径：物理行（与 scripts/architecture/ratchet.mjs 的 countPhysicalLines 同定义——末尾空行不算）。
 * 刻意不用 oxlint 的 max-lines 口径（skipBlankLines/skipComments），因为 split-plan 的批次验收
 * 与 review 计数都用物理行，两处口径必须一致才不会各说各话。
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const uiSrc = `${root}packages/ui/src`;

/** 已登记上帝组件的行数上限（物理行）。跌破 400 后删除对应条目。 */
const REGISTERED_LINE_CAPS = {
  // 2026-10-28 batch-2 选择器族外迁落地（7 picker → settings/automation/pickers/）：2799 → 1944。
  // 2026-10-28 batch-3 cron builder reducer 收敛落地（builder 簇 useState→useReducer）：1944 → 1925。
  "settings/AutomationEditView.tsx": 1925,
  // 2026-10-28 batch-1 helper 外迁落地（21 纯函数 + 6 常量 → settings/subagents/agentModel.ts，318 行）：2671 → 2416。
  // 2026-10-28 batch-2 列表/表单拆分落地（SubagentList + SubagentForm + SubagentModelOverrideControl +
  // SubagentFormFields + primitives，5 个新模块）：2416 → 1181。
  "settings/SubagentsSection.tsx": 1181,
  // 2026-10-28 batch-1 helper 外迁落地（navigationModel + 操作菜单 + 空态）：1979 → 1695。
  "settings/AutomationsSection.tsx": 1695,
  // 2026-10-28 batch-1 helper 外迁落地（remotePluginSyncModel/Types 拆出）：1898 → 1460。
  // 2026-10-28 batch-2 SelectionList/ProgressList/ResultList 三组件外迁落地：1460 → 1132。
  "settings/RemotePluginSyncDialog.tsx": 1132,
  // 2026-10-28 batch-1 helper 外迁落地（refresh queue / status / OAuth authorization build 纯逻辑 → settings/mcp/mcpSettingsModel.ts）：1595 → 1346。
  "settings/McpSettingsSection.tsx": 1346,
  // 2026-10-28 batch-4 helper 外迁落地（importModel + useExternalAgentImportCategoryState → settings/external-agent-import/）：1442 → 1050。
  "settings/ExternalAgentImportDialog.tsx": 1050,
  // 2026-10-28 batch-4 落地（PluginList controller hook + rows/detail/uninstall/空态等 9 叶子 → settings/plugins/）：1400 → 498。
  "settings/PluginsSection.tsx": 498,
  // 2026-10-28 batch-4 helper 外迁落地（drag data 读取器 / preview view 构建器 / 布局测量动画 → workspace-grouped-tasks/）：1747 → 1320。
  "WorkspaceGroupedTasksSection.tsx": 1320,
  // 2026-10-28 batch-4 落地（usage coding-plan 派生簇收口 useSettingsUsageCodingPlanSources + 纯函数/chrome 两叶子）：1725 → 1347。
  "SettingsPage.tsx": 1347,
  // 2026-10-28 batch-4 保守纯函数外迁（格式化/窗口/open-request 决策 → v4/conversationStatusPanelFormat.ts；组件与实时语义未动）：2246 → 2102。
  "v4/ConversationStatusPanel.tsx": 2102,
  // 2026-10-28 batch-5 外迁（侧栏宽度纯函数 → workspaceSidebarWidth.ts + resize controller → useWorkspaceSidebarResize.ts）：1980 → 1725。
  "app-shell/WorkspaceShellLayout.tsx": 1725,
  // 2026-10-28 batch-5 外迁（source 解析/错误分类/面包屑/延迟占位 → previewPane/ 四叶子）：1806 → 1447。
  "PreviewPane.tsx": 1447,
  // 2026-10-28 batch-5 外迁（任务工具栏受控组件 + viewMode 纯决策 + chrome 小组件 → WorkspaceSidebar/ 三叶子）：1701 → 1458。
  "WorkspaceSidebar.tsx": 1458,
  // 2026-10-28 batch-5 外迁（单美元公式归一化 + 文件链接目标族 → messageMarkdownMath.ts / messageFileLinkTargets.ts；删除死代码 knownExtensionlessFileNames）：1691 → 1337。
  "components/ai-elements/message.tsx": 1337,
  // 2026-10-28 batch-5 外迁（提交/别名纯决策 + 编辑器动作族 → lexical-chat-input/ 两叶子）：1517 → 1105。
  "LexicalChatInput.tsx": 1105,
};

/** 与 scripts/architecture/ratchet.mjs countPhysicalLines 同定义。 */
function countPhysicalLines(source) {
  return source
    .split(/\r?\n/)
    .filter((line, index, lines) => index < lines.length - 1 || line !== "").length;
}

test("已登记上帝组件不得超过其行数上限（ratchet：冻结当前水位，阻止隐形膨胀）", async () => {
  const grown = [];
  for (const [relative, cap] of Object.entries(REGISTERED_LINE_CAPS)) {
    const source = await readFile(`${uiSrc}/${relative}`, "utf8");
    const lines = countPhysicalLines(source);
    if (lines > cap) grown.push(`${relative}: ${lines} 行 > 上限 ${cap}（+${lines - cap}）`);
  }
  assert.deepEqual(
    grown,
    [],
    `以下已登记上帝组件超过其行数上限。ui 是 managed:false 模块，架构棘轮对「已超 400 后继续增长」\n` +
      `失明（review 2026-10-26 §6），故由本守护兜住。处置二选一：\n` +
      `  ① 按 god-component-split-plan.md 的批次把该文件拆到上限以下（首选，最终目标是跌破 400）；\n` +
      `  ② 若增长是合法成本（如 a11y 迁移），在本表显式上调上限并在提交信息写明理由——\n` +
      `     不得静默改数字让门禁变绿。\n` +
      `超限文件：\n  ` +
      grown.join("\n  "),
  );
});

test("登记表不含已消失或已跌破 400 的文件（防登记表腐坏）", async () => {
  const stale = [];
  for (const [relative, cap] of Object.entries(REGISTERED_LINE_CAPS)) {
    let source;
    try {
      source = await readFile(`${uiSrc}/${relative}`, "utf8");
    } catch {
      stale.push(`${relative}: 文件不存在（已删除或已迁移，请从本表移除）`);
      continue;
    }
    const lines = countPhysicalLines(source);
    if (lines <= 400) {
      stale.push(`${relative}: 已跌破 400（${lines} 行），拆分批次已完成，请从本表移除`);
    }
    if (cap <= 400) {
      stale.push(`${relative}: 上限 ${cap} ≤ 400，已由架构棘轮覆盖，无需本表登记`);
    }
  }
  assert.deepEqual(
    stale,
    [],
    `登记表与真实树不一致：\n  ` + stale.join("\n  "),
  );
});

test("登记表覆盖 split-plan 的全部已登记批次（防漏登记 = 防盲区重开）", async () => {
  // split-plan 用 `### \`<path>\`（<N> 行；...）` 标记每个登记批次。本断言确保每个登记文件
  // 都在本表里有上限——否则新登记的上帝组件会落在守护之外，盲区重开。
  const plan = await readFile(`${root}packages/ui/specs/god-component-split-plan.md`, "utf8");
  const registered = [
    ...plan.matchAll(/^### `([^`]+\.tsx)`（/gm),
  ].map((m) => m[1]);
  assert.ok(registered.length > 0, "split-plan 的登记标记格式变了？请同步本守护的解析正则");
  const missing = registered.filter((path) => !(path in REGISTERED_LINE_CAPS));
  assert.deepEqual(
    missing,
    [],
    `god-component-split-plan.md 登记了以下 .tsx 批次，但本守护的行数上限表未覆盖：\n  ` +
      missing.join("\n  ") +
      `\n请把它们加入 REGISTERED_LINE_CAPS（上限取当前实测物理行），否则这些文件的隐形增长无人看守。`,
  );
  // 反向：本表里出现 split-plan 已不登记的条目 = 登记表腐坏（上一条测试已覆盖不存在的情况）。
  const extra = Object.keys(REGISTERED_LINE_CAPS).filter((path) => !registered.includes(path));
  assert.deepEqual(
    extra,
    [],
    `本守护上限表含 split-plan 已不登记的文件（可能批次已完成但表未清理）：\n  ` + extra.join("\n  "),
  );
});
