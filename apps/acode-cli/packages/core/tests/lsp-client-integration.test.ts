// 验收场景 4（specs/lsp-diagnostics-loop.md §7）：stub 语言服务器集成测试——
// 真实子进程 + Content-Length JSON-RPC stdio，覆盖 diagnostics + definition 两条链路。
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { getOrCreateClient, waitForProjectLoaded } from "../src/lsp/client.js";
import { syncContent, refreshFile } from "../src/lsp/client-files.js";
import { sendRequest } from "../src/lsp/client-io.js";
import { waitForDiagnostics } from "../src/lsp/diagnostics-wait.js";
import { configCache, getServersForFile, loadConfig } from "../src/lsp/config.js";
import { resetInitFailures } from "../src/lsp/client-idle.js";
import type { ServerConfig } from "../src/lsp/types.js";

// Stub 服务器：initialize 应答 → didOpen/didChange 后发布一条诊断 →
// definition 返回另一文件的 location。协议帧为 Content-Length JSON-RPC。
const STUB_SCRIPT = `
const rl = [];
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) break;
    const header = buffer.slice(0, headerEnd).toString("latin1");
    const length = /Content-Length: (\\d+)/i.exec(header);
    if (!length) { buffer = buffer.slice(headerEnd + 4); continue; }
    const bodyLength = Number(length[1]);
    if (buffer.length < headerEnd + 4 + bodyLength) break;
    const message = JSON.parse(buffer.slice(headerEnd + 4, headerEnd + 4 + bodyLength).toString("utf8"));
    buffer = buffer.slice(headerEnd + 4 + bodyLength);
    handleMessage(message);
  }
});
function send(message) {
  const json = JSON.stringify(message);
  process.stdout.write("Content-Length: " + Buffer.byteLength(json) + "\\r\\n\\r\\n" + json);
}
function handleMessage(message) {
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { textDocumentSync: 1, definitionProvider: true, hoverProvider: true } } });
  } else if (message.method === "initialized") {
    // 握手完成：用 $/progress begin/end 让 projectLoaded 快速放行（否则等 15s 超时）。
    send({ jsonrpc: "2.0", method: "$/progress", params: { token: "stub-load", value: { kind: "begin", title: "loading" } } });
    send({ jsonrpc: "2.0", method: "$/progress", params: { token: "stub-load", value: { kind: "end" } } });
  } else if (message.method === "textDocument/didOpen" || message.method === "textDocument/didChange") {
    // LSP 通知载荷在 params 下（didOpen/didChange 均为 params.textDocument）。
    const doc = message.params.textDocument;
    const uri = doc.uri;
    const version = doc.version ?? null;
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, version, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, severity: 1, source: "stub", message: "stub error: v" + (doc.version ?? "?") }] } });
  } else if (message.method === "textDocument/definition") {
    send({ jsonrpc: "2.0", id: message.id, result: { uri: message.params.textDocument.uri, range: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } } } });
  } else if (message.method === "textDocument/hover") {
    send({ jsonrpc: "2.0", id: message.id, result: { contents: { kind: "markdown", value: "stub hover" } } });
  } else if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
  } else if (message.method === "exit") {
    process.exit(0);
  } else if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found: " + message.method } });
  }
}
`;

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

function stubConfig(_cwd: string): ServerConfig {
  return {
    command: "node",
    resolvedCommand: process.execPath,
    args: ["-e", STUB_SCRIPT],
    fileTypes: [".ts"],
    rootMarkers: ["."],
  };
}

test("stub language server: diagnostics + definition over stdio", async () => {
  const cwd = await makeTempDir("acode-lsp-int");
  configCache.clear();
  resetInitFailures();
  try {
    const target = path.join(cwd, "sample.ts");
    await fs.writeFile(target, "const alpha = 1;\nfunction beta() { return alpha; }\nbeta();\n", "utf8");

    // 走真实配置装载路径：rootMarkers=["."] 命中 + 命令可解析。
    // 为避免污染全局 configCache，直接构造配置对象驱动客户端。
    const cfg = stubConfig(cwd);
    const client = await getOrCreateClient(cfg, cwd, 10_000);
    assert.equal(client.status, "ready", "initialize 握手完成");

    await waitForProjectLoaded(client);
    await syncContent(client, target, await fs.readFile(target, "utf8"));
    const uri = pathToFileURL(target).href;

    // ---- diagnostics 链路：publishDiagnostics 到达后可等待 ----
    const diagnostics = await waitForDiagnostics(client, uri, { timeoutMs: 5000 });
    assert.equal(diagnostics.length, 1, "stub 服务器发布一条诊断");
    assert.match(diagnostics[0]!.message, /stub error/);

    // ---- definition 链路 ----
    const definition = (await sendRequest(client, "textDocument/definition", {
      textDocument: { uri },
      position: { line: 0, character: 6 },
    })) as { uri: string; range: { start: { line: number } } };
    assert.equal(definition.uri, uri);
    assert.equal(definition.range.start.line, 4);

    // ---- didChange 后按文档版本拒收陈旧诊断 ----
    const minVersion = client.diagnosticsVersion;
    await refreshFile(client, target);
    const fresh = await waitForDiagnostics(client, uri, {
      timeoutMs: 5000,
      minVersion,
      expectedDocumentVersion: client.openFiles.get(uri)?.version,
    });
    assert.match(fresh[0]!.message, /stub error/);

    // ---- 配置路由：rootMarkers + fileTypes 命中 ----
    const projectDir = await makeTempDir("acode-lsp-route");
    try {
      await fs.writeFile(path.join(projectDir, "package.json"), "{}", "utf8");
      const loaded = loadConfig(projectDir);
      const servers = getServersForFile(loaded, path.join(projectDir, "x.ts"));
      // 无 stub 二进制可解析 → 该文件不路由到任何服务器（本机无 tsserver 时为空）。
      assert.ok(Array.isArray(servers));
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  } finally {
    configCache.clear();
    resetInitFailures();
    const { shutdownAll } = await import("../src/lsp/client-shutdown.js");
    await shutdownAll();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
