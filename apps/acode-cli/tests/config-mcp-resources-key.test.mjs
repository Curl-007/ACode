// 配置入口 resources/sampling 键回归（specs/mcp-sampling-resources.md「配置入口同步登记」）：
// strict schema 漏键曾让整条 server 配置被跳过、拉取面工具永不合成（2026-10-11 实机事故）。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { loadFileConfig } = await import("../packages/adapters/src/config/file-config.adapter.js");

test("mcp server 配置的 resources/sampling 开关不被 strict 校验丢弃", () => {
  const dir = mkdtempSync(join(tmpdir(), "acode-cfg-"));
  const file = join(dir, "config.json");
  try {
    writeFileSync(
      file,
      JSON.stringify({
        mcp: {
          servers: {
            "resource-test": {
              command: "node",
              args: ["server.mjs"],
              resources: true,
              sampling: false,
            },
          },
        },
      }),
    );
    const loaded = loadFileConfig(file);
    const server = loaded.config?.mcp?.servers?.["resource-test"];
    assert.ok(server, "server 条目被 strict 校验整体丢弃");
    assert.equal(server.resources, true);
    assert.equal(server.sampling, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
