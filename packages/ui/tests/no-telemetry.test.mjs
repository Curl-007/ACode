import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
async function sources(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) =>
      e.isDirectory()
        ? sources(`${dir}/${e.name}`)
        : /\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts")
          ? [`${dir}/${e.name}`]
          : [],
    ),
  );
  return nested.flat();
}
test("UI and platform adapters have no telemetry collection or reporting entrypoints", async () => {
  for (const dir of ["packages/ui/src", "packages/web/src", "packages/desktop/src/renderer"]) {
    for (const file of await sources(root + dir)) {
      assert.doesNotMatch(
        await readFile(file, "utf8"),
        /reportTelemetryEvent|reportArmsCustomEvent|reportAppTelemetryEvent|runUserAction|startUserAction|ConversationTelemetrySupervisor|\/telemetry\//,
        file,
      );
    }
  }
});
test("platform and server do not expose or initialize reporting", async () => {
  assert.doesNotMatch(
    await readFile(root + "packages/shared/src/platform.ts", "utf8"),
    /reportTelemetryEvent|reportArmsCustomEvent|RendererActionTrace/,
  );
  for (const dir of ["packages/server/src", "packages/acode-server-cli/src"]) {
    for (const file of await sources(root + dir))
      assert.doesNotMatch(await readFile(file, "utf8"), /processResourceTelemetry\s*:/, file);
  }
});

// 2026-10-05 修复：原「purchase WebView 保留鉴权/主题/语言且不注入跟踪上下文」测试
// 依赖 src/settings/model-provider-section/codingPlanEmbeddedWebview.ts——该文件已随
// 购买 UI 整体移除（README「What was removed」：purchase UI and related copy are
// removed），测试未同步清理；ui 套件此前没有自动化入口，ENOENT 失败长期无人发现。
// 功能已不存在，守护语义随之反转：内嵌购买 WebView 与它的 report-context 注入面
// 不得回归——与本文件其余「防遥测回归」测试同一立场。
test("embedded purchase WebView and its report-context injection stay removed", async () => {
  assert.equal(
    existsSync(root + "packages/ui/src/settings/model-provider-section/codingPlanEmbeddedWebview.ts"),
    false,
    "内嵌购买 WebView 已随购买 UI 移除，不得以该文件形态回归",
  );
  for (const file of await sources(root + "packages/ui/src")) {
    assert.doesNotMatch(
      await readFile(file, "utf8"),
      /__acodeReportContext__|createCodingPlanAuthInjectionScript|createCodingPlanCredentialClearScript|acode:coding-plan:report-context/,
      file,
    );
  }
});
