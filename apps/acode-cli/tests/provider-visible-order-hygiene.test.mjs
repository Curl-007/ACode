import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * S3（能力提升方案批次 4）守护测试：provider-visible 排序集卫生。
 *
 * 排序集成员必须是真实注册的内建工具名——上游遗留的占位死名（EnterWorktree 等九个）
 * 曾误导维护者，并且是模型可见文本悬空引用的源头（prompt-corpus-audit F7：edit.ts 叫
 * 模型用不存在的 NotebookEdit、bash-gh-rate-limit 提 ScheduleWakeup）。
 *
 * 不变量：set ⊆ builtInTools 注册名 ∪ LEGACY_TOLERATED。未来往 set 里加没落地的名字，
 * 或者删掉 handler 却留着 set 名，这里都会红。
 */

const here = dirname(fileURLToPath(import.meta.url));
const orderSourcePath = join(here, "../packages/core/src/tool/provider-visible-order.ts");

const { orderProviderVisibleToolContracts } = await import(
  "../packages/core/src/tool/provider-visible-order.ts"
);
const { builtInTools } = await import("../packages/core/src/tool/handlers/index.ts");

// 遗留容忍词汇：background.ts 的任务类型映射与 off-peak 禁用列表仍处理旧会话 rollout 里
// 的 "Workflow" 工具名（handlers/index.ts 的 includeWorkflow 门同属遗留防御），但当前
// builtInTools 无该条目。保留在排序集与上述遗留面一致；落地或整体清理时同步移除。
const LEGACY_TOLERATED = new Set(["Workflow"]);

// 上游遗留、2026-10 批次 4（S3）确认全仓零注册的九个死名——永不回 set。
const REMOVED_DEAD_NAMES = [
  "EnterWorktree",
  "ExitWorktree",
  "LSP",
  "NotebookEdit",
  "ScheduleWakeup",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
];

function readSetMembers() {
  // 仓库 .ts 存在 CRLF/LF 混用，先归一再解析（同 plugin-foreign-manifest-compat 测试纪律）。
  const source = readFileSync(orderSourcePath, "utf8").replace(/\r\n/g, "\n");
  const block = source.match(/new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(block, "SORTED_PROVIDER_TOOL_NAMES set literal not found");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

test("S3: the nine dead upstream placeholder names stay removed", () => {
  const members = new Set(readSetMembers());
  for (const dead of REMOVED_DEAD_NAMES) {
    assert.ok(!members.has(dead), `dead placeholder name resurfaced in sort set: ${dead}`);
  }
});

test("S3: every sort-set member is a registered built-in tool (or documented legacy)", () => {
  const registered = new Set(builtInTools.map((entry) => entry.metadata.name));
  for (const name of readSetMembers()) {
    assert.ok(
      registered.has(name) || LEGACY_TOLERATED.has(name),
      `sort set contains name with no built-in entry: ${name}`,
    );
  }
});

test("S3: known live names remain in the set", () => {
  const members = new Set(readSetMembers());
  for (const live of [
    "Agent",
    "ApplyPatch",
    "Bash",
    "Edit",
    "Read",
    "Write",
    "Skill",
    "TaskOutput",
  ]) {
    assert.ok(members.has(live), `live tool name missing from sort set: ${live}`);
  }
});

test("orderProviderVisibleToolContracts sorts set members alphabetically first, locals keep order", () => {
  const ordered = orderProviderVisibleToolContracts([
    { name: "Write" },
    { name: "SomeLocalTool" },
    { name: "Bash" },
    { name: "Agent" },
    { name: "AnotherLocal" },
  ]).map((tool) => tool.name);
  assert.deepEqual(ordered, ["Agent", "Bash", "Write", "SomeLocalTool", "AnotherLocal"]);
});
