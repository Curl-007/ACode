import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createVisualizationVendorFileServer,
  installVisualizationVendorProtocol,
  parseVisualizationVendorRequestUrl,
  VISUALIZATION_VENDOR_SCHEME,
} from "../src/main/visualizationVendorProtocol.js";

/**
 * 可视化卡片 vendored 钉版渲染库的桌面协议守护
 * （packages/ui/specs/gen-ui-visualize-card.md「vendored 钉版渲染库」）：
 * 请求面只认单 host + 钉版文件名形状；资产装载 fail-closed（缺 manifest /
 * sha256 不符一律拒绝）；scheme 字面量与 ui 侧单一约定两侧钉死。
 */

const DESKTOP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = join(DESKTOP_ROOT, "..", "..");

const MERMAID_FILE_NAME = "npm_mermaid@11.17.2_mermaid.min.js";
const CHARTJS_FILE_NAME = "npm_chart.js@4.5.0_chart.umd.min.js";

test("scheme 单一事实源在 packages/shared；ui/main 两侧都经再导出引用（字面量钉死）", () => {
  const sharedPlatformSource = readFileSync(
    join(REPO_ROOT, "packages/shared/src/platform.ts"),
    "utf-8",
  );
  assert.match(
    sharedPlatformSource,
    /export const VISUALIZATION_VENDOR_SCHEME = "acode-viz-vendor";/u,
    "shared 侧 scheme 常量漂移——renderer 重写与 main 协议将互相打空",
  );
  const uiVendorSource = readFileSync(
    join(REPO_ROOT, "packages/ui/src/lib/visualizationVendor.ts"),
    "utf-8",
  );
  assert.match(
    uiVendorSource,
    /VISUALIZATION_VENDOR_SCHEME[^;]*from "@acode\/shared"/u,
    "ui 侧必须经 @acode/shared 再导出引用 scheme，不得回退为本地字面量",
  );
  assert.equal(VISUALIZATION_VENDOR_SCHEME, "acode-viz-vendor");
});

test("请求解析：只认 vendor host + 钉版文件名；穿越/别名/嵌套路径全部拒绝", () => {
  assert.equal(
    parseVisualizationVendorRequestUrl(
      `${VISUALIZATION_VENDOR_SCHEME}://vendor/${MERMAID_FILE_NAME}`,
    ),
    MERMAID_FILE_NAME,
  );
  assert.equal(
    parseVisualizationVendorRequestUrl(
      `${VISUALIZATION_VENDOR_SCHEME}://vendor/${CHARTJS_FILE_NAME}`,
    ),
    CHARTJS_FILE_NAME,
  );
  const rejected = [
    "https://vendor/" + MERMAID_FILE_NAME, // 错误 scheme
    `${VISUALIZATION_VENDOR_SCHEME}://evil/${MERMAID_FILE_NAME}`, // 错误 host
    `${VISUALIZATION_VENDOR_SCHEME}://vendor/`, // 空名
    `${VISUALIZATION_VENDOR_SCHEME}://vendor/evil.js`, // 非钉版形状
    `${VISUALIZATION_VENDOR_SCHEME}://vendor/..%2F..%2Fsecret.js`, // %2F 穿越
    `${VISUALIZATION_VENDOR_SCHEME}://vendor/sub/${MERMAID_FILE_NAME}`, // 嵌套路径
    `${VISUALIZATION_VENDOR_SCHEME}://vendor/${MERMAID_FILE_NAME}%00.png`, // NUL 别名
    "not a url",
  ];
  for (const url of rejected) {
    assert.equal(parseVisualizationVendorRequestUrl(url), null, `应拒绝 ${url}`);
  }
});

function fakeFs(files) {
  const reads = [];
  return {
    reads,
    readFileBytes: async (path) => {
      reads.push(path);
      const key = path.replaceAll("\\", "/");
      for (const [suffix, bytes] of Object.entries(files)) {
        if (key.endsWith(suffix)) return bytes;
      }
      throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
    },
  };
}

const encoder = new TextEncoder();

function manifestJson(entries) {
  return encoder.encode(JSON.stringify({ version: 1, libraries: entries }));
}

test("资产装载：sha256 相符才放行；不符/缺 manifest/缺文件一律 null（fail-closed）", async () => {
  const bytes = encoder.encode("console.log(1);");
  const sha256Hex = () => "a".repeat(64); // 注入伪哈希：manifest 里写同值即“相符”
  const vendorDir = "/assets/visualization-vendor";

  // 相符 → 放行 + 二次装载走缓存（不再读盘）。
  const okFs = fakeFs({
    "manifest.json": manifestJson([{ fileName: MERMAID_FILE_NAME, sha256: "a".repeat(64) }]),
    [MERMAID_FILE_NAME]: bytes,
  });
  const okServer = createVisualizationVendorFileServer({
    resolveVendorDir: () => vendorDir,
    readFileBytes: okFs.readFileBytes,
    sha256Hex,
  });
  assert.deepEqual(await okServer.load(MERMAID_FILE_NAME), bytes);
  const readsAfterFirst = okFs.reads.length;
  assert.deepEqual(await okServer.load(MERMAID_FILE_NAME), bytes);
  assert.equal(okFs.reads.length, readsAfterFirst, "已校验字节应走缓存，不重复读盘");

  // sha256 不符（打包后被替换）→ 拒绝。
  const tamperedServer = createVisualizationVendorFileServer({
    resolveVendorDir: () => vendorDir,
    readFileBytes: fakeFs({
      "manifest.json": manifestJson([{ fileName: MERMAID_FILE_NAME, sha256: "b".repeat(64) }]),
      [MERMAID_FILE_NAME]: bytes,
    }).readFileBytes,
    sha256Hex,
  });
  assert.equal(await tamperedServer.load(MERMAID_FILE_NAME), null);

  // 缺 manifest → 拒绝。
  const noManifestServer = createVisualizationVendorFileServer({
    resolveVendorDir: () => vendorDir,
    readFileBytes: fakeFs({ [MERMAID_FILE_NAME]: bytes }).readFileBytes,
    sha256Hex,
  });
  assert.equal(await noManifestServer.load(MERMAID_FILE_NAME), null);

  // manifest 有目录但文件缺席 → 拒绝。
  const missingFileServer = createVisualizationVendorFileServer({
    resolveVendorDir: () => vendorDir,
    readFileBytes: fakeFs({
      "manifest.json": manifestJson([{ fileName: MERMAID_FILE_NAME, sha256: "a".repeat(64) }]),
    }).readFileBytes,
    sha256Hex,
  });
  assert.equal(await missingFileServer.load(MERMAID_FILE_NAME), null);
});

test("协议应答：合法请求 200 + text/javascript + ACAO；非法/未登记一律 404", async () => {
  const bytes = encoder.encode("console.log(1);");
  let handler = null;
  installVisualizationVendorProtocol(
    {
      handle: (scheme, installed) => {
        assert.equal(scheme, VISUALIZATION_VENDOR_SCHEME);
        handler = installed;
      },
    },
    createVisualizationVendorFileServer({
      resolveVendorDir: () => "/assets/visualization-vendor",
      readFileBytes: fakeFs({
        "manifest.json": manifestJson([{ fileName: MERMAID_FILE_NAME, sha256: "a".repeat(64) }]),
        [MERMAID_FILE_NAME]: bytes,
      }).readFileBytes,
      sha256Hex: () => "a".repeat(64),
    }),
  );
  assert.equal(typeof handler, "function", "protocol.handle 必须被调用");

  const ok = await handler({ url: `${VISUALIZATION_VENDOR_SCHEME}://vendor/${MERMAID_FILE_NAME}` });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Content-Type"), "text/javascript; charset=utf-8");
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), "*");
  assert.deepEqual(new Uint8Array(await ok.arrayBuffer()), bytes);

  const badHost = await handler({ url: `${VISUALIZATION_VENDOR_SCHEME}://evil/x.js` });
  assert.equal(badHost.status, 404);
  const unknown = await handler({
    url: `${VISUALIZATION_VENDOR_SCHEME}://vendor/npm_x@1.0.0_x.js`,
  });
  assert.equal(unknown.status, 404);
});

test("index.ts 接线：ready 前注册 scheme，ready 后在 defaultSession 安装协议", () => {
  const indexSource = readFileSync(join(DESKTOP_ROOT, "src/main/index.ts"), "utf-8");
  assert.match(indexSource, /registerVisualizationVendorScheme\(protocol\);/u);
  assert.match(indexSource, /installVisualizationVendorProtocol\(/u);
  assert.match(
    indexSource,
    /"\.\.\/renderer\/visualization-vendor"/u,
    "vendor 目录必须锚定 renderer 产物目录（electron-builder files 含 out/**/*）",
  );
  // 注册必须发生在模块顶层（app ready 前）：出现在 whenReady 之前的区段。
  const registerIndex = indexSource.indexOf("registerVisualizationVendorScheme(protocol);");
  const whenReadyIndex = indexSource.indexOf("app.whenReady()");
  assert.ok(registerIndex > 0 && registerIndex < whenReadyIndex);
});
