import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 桌面宿主 env 守护（apps/acode-cli/specs/script-workflow-revival.md R5 增补）。
 *
 * 源码级守护的理由（同 script-workflow-agent-cap.test.mjs 的先例）：行为级复现需要真实
 * Electron 宿主——process.execPath 指向 Helper 二进制、且 CLI 启动时把
 * ELECTRON_RUN_AS_NODE 从自身 env sanitize 掉——纯 node 测试进程构造不出这个环境；
 * 而缺陷形态是「spawn 选项里少一个 env 键」，源码级即可精确钉住。
 *
 * 缺陷本体：RunWorkflow 的 run 子进程按完整 Electron/Chromium 应用启动，stdout 变成
 * GUI 日志行（`[2026-...]` 前缀），handleChildLine 的 JSON.parse 对它抛
 * 「Expected ',' or ']' after array element in JSON at position 7」，run 失败或卡死。
 * dwf 侧同款缺陷已在 dynamic-workflow-runtime/harness.ts 修复（桌面端 CreateWorkflow
 * 因此可用），脚本工作流侧曾漏掉——本守护防止两条 spawn 路径再次分叉。
 */

const cliRoot = new URL("../", import.meta.url);
// core.autocrlf=true 的机器上工作区是 CRLF；归一为 LF 再做位置敏感断言。
const read = (path) =>
  readFile(new URL(path, cliRoot), "utf8").then((text) => text.replace(/\r\n/g, "\n"));

test("script-workflow run 子进程 spawn 显式携带 ELECTRON_RUN_AS_NODE=1", async () => {
  const source = await read("packages/cli-workflow/src/script-workflow-process.ts");
  const spawnIndex = source.indexOf("spawn(process.execPath, [entry.path], {");
  assert.ok(spawnIndex !== -1, "spawn 调用点未找到（形态变了就重新钉守护）");
  const spawnBlock = source.slice(spawnIndex, source.indexOf("});", spawnIndex));
  assert.ok(
    spawnBlock.includes('ELECTRON_RUN_AS_NODE: "1"'),
    "run 子进程 spawn 必须显式携带 ELECTRON_RUN_AS_NODE=1（R5 增补：桌面 Electron Helper 宿主）",
  );
  assert.ok(
    spawnBlock.includes("...process.env"),
    "env 必须显式透传扩展而非整体替换（子进程仍需宿主环境）",
  );
});

test("既有 env 先例不回退：dwf harness 与 official-plugin-runtime", async () => {
  const harness = await read("packages/dynamic-workflow-runtime/src/harness.ts");
  assert.ok(
    harness.includes('ELECTRON_RUN_AS_NODE: "1"'),
    "dwf harness 的 spawn env 被移除会让桌面端 CreateWorkflow 回归同款故障",
  );
  const plugin = await read("packages/bootstrap/src/app/official-plugin-runtime.ts");
  assert.equal(
    plugin.split('ELECTRON_RUN_AS_NODE: "1"').length - 1,
    2,
    "official-plugin-runtime 的两处 spawn 都必须携带 ELECTRON_RUN_AS_NODE",
  );
});
