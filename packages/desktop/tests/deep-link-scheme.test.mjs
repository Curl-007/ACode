import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * F6（2026-10-04，docs/prompt-corpus-audit-2026-10.md 增补发现 + 同日更正）钉桩：
 * deep link 协议身份的单一事实源与发射端一致性。
 *
 * 普查更正后的事实：OS 注册面自 fork 初始提交起就是 acode://（electron-builder
 * protocols / setAsDefaultProtocolClient / x-scheme-handler 全是 acode）；F6 的真实
 * 问题是两个 zcode:// **发射端**（macOS Finder 工作流脚本、OAuth 官网中转页 redirect
 * 参数）与受理端不匹配——链路本就断，同机上游 ZCode 还会抢收。裁决：发射端对齐
 * acode://，**不做 zcode:// 兼容注册**（本 fork 无存量 zcode:// 外链可保，注册它
 * 反而与上游抢默认 handler）。本测试钉住该裁决的每个面，防漂移回上游品牌协议。
 */

const DESKTOP_ROOT = new URL("..", import.meta.url).pathname.replace(/^\//, "");
const REPO_ROOT = join(DESKTOP_ROOT, "..", "..");

function read(relPath) {
  return readFileSync(join(DESKTOP_ROOT, relPath), "utf-8");
}

test("(F6) scheme 单一事实源：DEEP_LINK_SCHEME 导出且注册端复用，不再各写一份字面量", () => {
  const urlSource = read("src/main/desktopDeepLinkUrl.ts");
  assert.match(urlSource, /export const DEEP_LINK_SCHEME = "acode";/);

  const oauthSource = read("src/main/desktopOAuthDeepLink.ts");
  assert.match(oauthSource, /DEEP_LINK_SCHEME,[\s\S]*?from "\.\/desktopDeepLinkUrl\.js"/);
  assert.match(oauthSource, /const scheme = DEEP_LINK_SCHEME;/);
  assert.ok(!oauthSource.includes('const scheme = "acode"'), "注册端不得再写死第二份 scheme 字面量");
});

test("(F6) Finder 工作流发射端 = acode://workspace/open，版本已推进触发已装机刷新", () => {
  const source = read("src/main/desktopFinderOpenFolderWorkflow.ts");
  assert.ok(source.includes('"acode://workspace/open?path='), "发射 URL 必须是 acode://");
  assert.ok(!source.includes("zcode://"), "不得残留 zcode:// 发射");
  // 版本推进让安装器的内容比对把已装机器上的旧脚本刷成新发射端。
  assert.match(source, /const WORKFLOW_VERSION = "6";/);
});

test("(F6) 打包期注册面钉桩：electron-builder protocols 只声明 acode", () => {
  const config = read("electron-builder.config.js");
  assert.match(config, /schemes:\s*\[\s*"acode"\s*\]/);
  assert.ok(!config.includes('"zcode"'), "不得把 zcode 加回注册面（与上游抢默认 handler 的反噬，见 spec 裁决）");
});

test("(F6) desktop/src 与 services/src 零 zcode:// 残留（发射端根除的 grep 级不变量）", () => {
  const roots = [join(DESKTOP_ROOT, "src"), join(REPO_ROOT, "packages", "services", "src")];
  const offenders = [];
  for (const root of roots) {
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(ts|tsx|mjs|js)$/.test(entry.name)) continue;
      const full = join(entry.parentPath ?? entry.path, entry.name);
      if (readFileSync(full, "utf-8").includes("zcode://")) {
        offenders.push(full.slice(REPO_ROOT.length + 1));
      }
    }
  }
  assert.deepEqual(offenders, [], `zcode:// 发射端残留: ${offenders.join(", ")}`);
  // 事实性上游引用（zcode-plan 错误码、zcode.z.ai 域名）不在此断言范围——它们不含 "://"。
});
