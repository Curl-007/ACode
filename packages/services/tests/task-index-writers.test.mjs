import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// specs/task-index-write-ownership.md 守护测试：task index 派生库的写入方白名单。
// 2026-10-05 深度审查发现派生索引写入方分散（syncer/adapter/automation/导入/修复器），
// 历史上已发生过一次漂移事故（repairSubagentTaskIndex：冷恢复 child 被写进主列表）。
// 本测试把「靠纪律」变成「靠门禁」：任何新文件引用 TaskIndexRepo/taskIndexRepo
// 而未登记进 spec 白名单时直接红，逼写入路径的扩张经过显式评审。

const root = fileURLToPath(new URL("../../../", import.meta.url));
const servicesSrc = `${root}packages/services/src`;

// 与 spec 登记表一一对应（相对 packages/services/src 的 posix 路径）。
const ALLOWED_WRITERS = new Set([
  "acode-agent/acodeAgentService.ts",
  "acode-agent/acodeTaskIndexSyncer.ts",
  "acode-agent/acodeTaskServiceAdapter.ts",
  "acode-agent/repairSubagentTaskIndex.ts",
  "node.ts",
  "session/claude-native/claudeNativeSessionImportService.ts",
  "session/claude-native/persistImportedClaudeTask.ts",
  "session/external-import/importService.ts",
  "session/taskIndexRepo.ts",
  "session/tasksDatabase/startup.ts",
]);

async function collectSources(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = `${dir}/${entry.name}`;
      return entry.isDirectory()
        ? collectSources(full)
        : /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")
          ? [full]
          : [];
    }),
  );
  return nested.flat();
}

test("task index 写入方仅限 spec 白名单（新增写入方须先更新 task-index-write-ownership.md）", async () => {
  const offenders = [];
  for (const file of await collectSources(servicesSrc)) {
    const source = await readFile(file, "utf8");
    // 只匹配对存储本体的引用：import 路径 taskIndexRepo.js 或符号 TaskIndexRepo。
    if (!/taskIndexRepo(?:\.js)?["']|TaskIndexRepo\b/.test(source)) continue;
    const relative = file.slice(servicesSrc.length + 1);
    if (!ALLOWED_WRITERS.has(relative)) offenders.push(relative);
  }
  assert.deepEqual(
    offenders,
    [],
    `发现未登记的 task index 写入方: ${offenders.join(", ")}；` +
      "请先在 packages/services/specs/task-index-write-ownership.md 登记角色与约束，再加入白名单",
  );
});

test("白名单不含已消失的文件（防止登记表腐坏）", async () => {
  const missing = [];
  for (const relative of ALLOWED_WRITERS) {
    try {
      await readFile(`${servicesSrc}/${relative}`, "utf8");
    } catch {
      missing.push(relative);
    }
  }
  assert.deepEqual(missing, [], `白名单中的文件已不存在，请同步清理 spec 与本测试: ${missing.join(", ")}`);
});
