import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVisualizationVendorRelativePath,
  buildVisualizationVendorScriptUrl,
  isVisualizationVendorFileName,
  resolveVisualizationVendorRuntime,
  rewriteVisualizationVendorReferences,
  VISUALIZATION_VENDOR_DIRECTORY,
  VISUALIZATION_VENDOR_LIBRARIES,
  VISUALIZATION_VENDOR_SCHEME,
  VISUALIZATION_VENDOR_SCHEME_HOST,
} from "../src/lib/visualizationVendor.js";
import {
  buildVisualizationCspDirective,
  buildVisualizationSandboxDocument,
  VISUALIZATION_CSP_DIRECTIVE,
  VISUALIZATION_IFRAME_SANDBOX,
} from "../src/lib/visualizationSandbox.js";
import {
  assertVisualizationVendorIntegrity,
  buildVisualizationVendorArtifact,
  buildVisualizationVendorManifest,
  loadVisualizationVendorAssets,
  VisualizationVendorIntegrityError,
} from "../vite/visualizationVendorPlugin.js";

/**
 * vendored 钉版渲染库（specs/gen-ui-visualize-card.md「vendored 钉版渲染库与 CSP
 * 本地源」）的安全与完整性守护。红线：本地源只进 script-src；connect-src 'none'
 * 与 sandbox="allow-scripts" 不因 vendor 面而松动。
 */

const MERMAID = VISUALIZATION_VENDOR_LIBRARIES.find((entry) => entry.package === "mermaid");
const CHARTJS = VISUALIZATION_VENDOR_LIBRARIES.find((entry) => entry.package === "chart.js");

test("目录：mermaid/chart.js 钉版登记，文件名带版本，sha256 形状合法", () => {
  assert.ok(MERMAID, "mermaid 必须在钉版目录里");
  assert.ok(CHARTJS, "chart.js 必须在钉版目录里");
  assert.equal(MERMAID?.version, "11.17.2");
  assert.equal(CHARTJS?.version, "4.5.0");
  const fileNames = new Set<string>();
  for (const library of VISUALIZATION_VENDOR_LIBRARIES) {
    // 命名约定 `npm_<pkg>@<ver>_<dist路径，/ 换 _>`：钉版文件名即内容身份（可强缓存）。
    assert.ok(
      library.fileName.startsWith(`npm_${library.package}@${library.version}_`),
      `${library.fileName} 必须内嵌包名与钉版版本`,
    );
    assert.match(library.sha256, /^[0-9a-f]{64}$/u, `${library.fileName} 的 sha256 形状非法`);
    assert.ok(isVisualizationVendorFileName(library.fileName));
    assert.ok(!fileNames.has(library.fileName), "文件名不得重复");
    fileNames.add(library.fileName);
  }
});

test("文件名校验：拒绝路径穿越与非钉版形状", () => {
  assert.equal(isVisualizationVendorFileName("npm_mermaid@11.17.2_mermaid.min.js"), true);
  assert.equal(isVisualizationVendorFileName("npm_chart.js@4.5.0_chart.umd.min.js"), true);
  for (const bad of [
    "../secret.js",
    "a/b.js",
    "evil.js",
    "npm_mermaid@11.17.2_mermaid.min.js%00.png",
    "npm_@1_x.js",
    "",
    "NPM_mermaid@11.17.2_mermaid.min.js",
  ]) {
    assert.equal(isVisualizationVendorFileName(bad), false, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test("运行态解析：file: 页面 → scheme 运行态；http(s) → 源+目录前缀", () => {
  const desktopProduction = resolveVisualizationVendorRuntime(
    "file:///C:/app/out/renderer/index.html",
  );
  assert.equal(desktopProduction.kind, "scheme");
  assert.equal(desktopProduction.cspSource, `${VISUALIZATION_VENDOR_SCHEME}:`);
  assert.equal(
    desktopProduction.baseUrl,
    `${VISUALIZATION_VENDOR_SCHEME}://${VISUALIZATION_VENDOR_SCHEME_HOST}/`,
  );

  const webRoot = resolveVisualizationVendorRuntime("https://app.example.com/index.html");
  assert.equal(webRoot.kind, "origin");
  assert.equal(webRoot.cspSource, `https://app.example.com/${VISUALIZATION_VENDOR_DIRECTORY}/`);

  // 子路径部署：CSP 源是「文档所在目录下的 vendor 目录」精确前缀，不是裸 origin。
  const webSubPath = resolveVisualizationVendorRuntime(
    "https://app.example.com/app/index.html?launch=1#frag",
  );
  assert.equal(
    webSubPath.cspSource,
    `https://app.example.com/app/${VISUALIZATION_VENDOR_DIRECTORY}/`,
  );

  const desktopDev = resolveVisualizationVendorRuntime("http://localhost:5174/index.html");
  assert.equal(desktopDev.kind, "origin");
  assert.equal(desktopDev.cspSource, `http://localhost:5174/${VISUALIZATION_VENDOR_DIRECTORY}/`);
});

test("重写：scheme 运行态替换规范相对引用（含 import() 字符串），origin 运行态不动片段", () => {
  assert.ok(MERMAID);
  const canonical = buildVisualizationVendorRelativePath(MERMAID!.fileName);
  const fragment = [
    `<script src="${canonical}"></script>`,
    `<script>await import("${canonical}");</script>`,
    `<img src="visualization-vendor/not-in-catalog.js">`,
    `<script src="https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js"></script>`,
  ].join("\n");

  const schemeRuntime = resolveVisualizationVendorRuntime("file:///app/out/renderer/index.html");
  const rewritten = rewriteVisualizationVendorReferences(fragment, schemeRuntime);
  const schemeUrl = buildVisualizationVendorScriptUrl(schemeRuntime, MERMAID!.fileName);
  assert.equal(schemeUrl, `${VISUALIZATION_VENDOR_SCHEME}://vendor/${MERMAID!.fileName}`);
  assert.equal(rewritten.split(schemeUrl).length - 1, 2, "script src 与 import() 都要重写");
  assert.ok(!rewritten.includes(`src="${canonical}"`), "规范相对路径不得残留");
  // 目录外文件名与 CDN 回退引用不受影响。
  assert.ok(rewritten.includes("visualization-vendor/not-in-catalog.js"));
  assert.ok(rewritten.includes("https://cdn.jsdelivr.net/npm/mermaid@11.17.2"));

  const originRuntime = resolveVisualizationVendorRuntime("https://app.example.com/index.html");
  assert.equal(rewriteVisualizationVendorReferences(fragment, originRuntime), fragment);
});

test("CSP：vendor 源只进 script-src；connect-src 'none' 与基线红线不动", () => {
  const schemeRuntime = resolveVisualizationVendorRuntime("file:///app/out/renderer/index.html");
  const directive = buildVisualizationCspDirective([schemeRuntime.cspSource]);
  const directives = directive.split("; ");
  const scriptSrc = directives.find((entry) => entry.startsWith("script-src"));
  assert.ok(scriptSrc?.includes(`${VISUALIZATION_VENDOR_SCHEME}:`), "script-src 必须含 vendor 源");
  assert.ok(scriptSrc?.includes("'unsafe-inline'"), "既有内联面保留");
  // 红线逐字不动。
  assert.ok(directives.includes("connect-src 'none'"));
  assert.ok(directives.includes("default-src 'none'"));
  assert.ok(directives.includes("form-action 'none'"));
  assert.ok(directives.includes("base-uri 'none'"));
  // vendor 源不得泄漏进 connect/style/img/font 面。
  for (const face of ["connect-src", "style-src", "img-src", "font-src"]) {
    const entry = directives.find((line) => line.startsWith(face));
    assert.ok(entry && !entry.includes(VISUALIZATION_VENDOR_SCHEME), `${face} 不得含 vendor 源`);
  }
  // 无 vendor 参数时与既有静态常量逐字节一致（向后兼容面）。
  assert.equal(buildVisualizationCspDirective(), VISUALIZATION_CSP_DIRECTIVE);
  assert.equal(VISUALIZATION_IFRAME_SANDBOX, "allow-scripts");
});

test("沙箱文档：vendor 运行态注入 CSP 本地源并按运行态重写片段", () => {
  assert.ok(CHARTJS);
  const canonical = buildVisualizationVendorRelativePath(CHARTJS!.fileName);
  const fragment = `<div id="c"></div><script src="${canonical}"></script>`;
  const schemeRuntime = resolveVisualizationVendorRuntime("file:///app/out/renderer/index.html");
  const document = buildVisualizationSandboxDocument(fragment, "--background:#fff", schemeRuntime);
  assert.ok(
    document.includes(`content="${buildVisualizationCspDirective([schemeRuntime.cspSource])}"`),
  );
  assert.ok(document.includes(`${VISUALIZATION_VENDOR_SCHEME}://vendor/${CHARTJS!.fileName}`));
  assert.ok(!document.includes(`src="${canonical}"`));
  // 既有顺序约束不因 vendor 面破坏：shim 先于 fragment。
  assert.ok(document.indexOf("window.acodeViz") < document.indexOf('<div id="c">'));
});

test("构建期完整性：真实 node_modules 钉版 dist 与目录 sha256 一致", async () => {
  const assets = await loadVisualizationVendorAssets();
  assert.equal(assets.length, VISUALIZATION_VENDOR_LIBRARIES.length);
  for (const asset of assets) {
    const library = VISUALIZATION_VENDOR_LIBRARIES.find(
      (entry) => entry.fileName === asset.fileName,
    );
    assert.ok(library, `${asset.fileName} 不在目录里`);
    assert.equal(asset.sha256, library!.sha256);
    assert.ok(asset.source.byteLength > 100_000, "工件字节明显过小，疑似读错文件");
  }
});

test("构建期完整性：字节被篡改 → VisualizationVendorIntegrityError（构建失败路径）", () => {
  assert.ok(MERMAID);
  const tampered = new TextEncoder().encode("tampered-bytes");
  assert.throws(
    () => assertVisualizationVendorIntegrity(MERMAID!, tampered),
    (error: unknown) =>
      error instanceof VisualizationVendorIntegrityError &&
      /integrity mismatch/u.test(error.message),
  );
  // 注入伪读取器：dist 字节不等于钉版哈希时 loadVisualizationVendorAssets 必须抛错。
  return assert.rejects(
    loadVisualizationVendorAssets({ readPackageFile: async () => tampered }),
    VisualizationVendorIntegrityError,
  );
});

test("license banner：mermaid（esbuild IIFE 无头注释）前置钉版 banner，chart.js 原样", () => {
  assert.ok(MERMAID?.licenseBanner, "mermaid dist 无 license 头，构建期必须前置 banner");
  const distBytes = new TextEncoder().encode("DIST");
  const artifact = buildVisualizationVendorArtifact(MERMAID!, distBytes);
  const text = new TextDecoder().decode(artifact);
  assert.ok(text.startsWith(`${MERMAID!.licenseBanner}\nDIST`));
  assert.ok(CHARTJS && !CHARTJS.licenseBanner, "chart.js UMD 自带 MIT banner，不得重复前置");
  if (CHARTJS) {
    assert.equal(buildVisualizationVendorArtifact(CHARTJS, distBytes), distBytes);
  }
});

test("manifest：确定性字节、按 fileName 排序、逐库携带钉版 sha256", async () => {
  const assets = await loadVisualizationVendorAssets();
  const first = buildVisualizationVendorManifest(assets);
  const second = buildVisualizationVendorManifest([...assets].reverse());
  assert.deepEqual(first, second, "manifest 必须与输入顺序无关（确定性产物）");
  const parsed = JSON.parse(new TextDecoder().decode(first)) as {
    version: number;
    libraries: Array<{ fileName: string; sha256: string; package: string; version: string }>;
  };
  assert.equal(parsed.version, 1);
  assert.equal(parsed.libraries.length, VISUALIZATION_VENDOR_LIBRARIES.length);
  const names = parsed.libraries.map((entry) => entry.fileName);
  assert.deepEqual(names, [...names].sort(), "libraries 必须按 fileName 排序");
  for (const entry of parsed.libraries) {
    const library = VISUALIZATION_VENDOR_LIBRARIES.find(
      (candidate) => candidate.fileName === entry.fileName,
    );
    assert.equal(entry.sha256, library?.sha256);
    assert.equal(entry.package, library?.package);
    assert.equal(entry.version, library?.version);
  }
});
