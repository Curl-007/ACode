import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// spec: packages/desktop/specs/provisioning-transport-encryption-gate.md 验收场景 1-4。
// provisioning 信封携带解密后的明文凭据；传输加密分类是 Main 侧唯一门槛的判定事实来源。
const { resolveProvisioningTransportSecurity } =
  await import("../src/main/remoteTargetTransportSecurity.ts");

function readSource(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

test("stdio 形态判为加密：ssh（SSH 隧道不误伤）、wsl/docker（同机管道）", () => {
  const ssh = resolveProvisioningTransportSecurity({
    kind: "ssh",
    host: "example.com",
    username: "user",
  });
  assert.equal(ssh.encrypted, true);
  assert.equal(ssh.reason, "ssh-tunnel-stdio");

  const wsl = resolveProvisioningTransportSecurity({ kind: "wsl", distro: "Ubuntu" });
  assert.equal(wsl.encrypted, true);
  assert.equal(wsl.reason, "local-stdio");

  const docker = resolveProvisioningTransportSecurity({ kind: "docker", container: "dev" });
  assert.equal(docker.encrypted, true);
  assert.equal(docker.reason, "local-stdio");
});

test("server kind：wss:// 与 https:// 判为加密（TLS）", () => {
  for (const url of ["wss://studio.example.com:3030", "https://studio.example.com:3030"]) {
    const result = resolveProvisioningTransportSecurity({ kind: "server", url });
    assert.equal(result.encrypted, true, url);
    assert.equal(result.reason, "tls");
  }
});

test("server kind：ws://、http://、未知协议、非法 URL 一律 fail-closed 判为未加密", () => {
  const plaintext = resolveProvisioningTransportSecurity({
    kind: "server",
    url: "ws://studio.example.com:3030",
  });
  assert.equal(plaintext.encrypted, false);
  assert.equal(plaintext.reason, "plaintext-http");

  const http = resolveProvisioningTransportSecurity({
    kind: "server",
    url: "http://127.0.0.1:3030/ws",
  });
  assert.equal(http.encrypted, false);
  assert.equal(http.reason, "plaintext-http");

  const unknown = resolveProvisioningTransportSecurity({
    kind: "server",
    url: "ftp://example.com",
  });
  assert.equal(unknown.encrypted, false);
  assert.equal(unknown.reason, "unknown-protocol");

  const invalid = resolveProvisioningTransportSecurity({ kind: "server", url: "not a url" });
  assert.equal(invalid.encrypted, false);
  assert.equal(invalid.reason, "invalid-url");
});

test("源码不变量：handleConnected 的 provisioning 注册必须先经传输加密门槛", () => {
  // desktopRemoteSessions.ts 绑定 electron 无法在 node:test 里直接 import；
  // 参照 apps/acode-cli/tests/auth-login-vault-wiring.test.mjs 的源码不变量先例守护接线。
  const src = readSource("../src/main/desktopRemoteSessions.ts");
  const gateIdx = src.indexOf("resolveProvisioningTransportSecurity(descriptor.target)");
  assert.ok(gateIdx >= 0, "handleConnected 必须调用 resolveProvisioningTransportSecurity");
  const branchIdx = src.indexOf("if (transportSecurity.encrypted)");
  assert.ok(branchIdx > gateIdx, "注册必须受 encrypted 分支门控");
  const registerIdx = src.indexOf("providerProvisioningCoordinator.register(");
  assert.ok(registerIdx > branchIdx, "coordinator.register 只能出现在加密分支内");
  assert.ok(
    src.includes("Skip sync over unencrypted transport"),
    "未加密分支必须留下结构化 warn 日志",
  );
  assert.ok(
    src.includes("emitConnectionLog(pending.win"),
    "未加密分支必须向连接日志 UI 告警（复用既有机制）",
  );
});
