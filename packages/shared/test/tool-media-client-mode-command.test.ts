// U11 clientMode 接线的 shared v4 命令面落点（spec:
// apps/acode-cli/specs/tool-media-attachment-ref.md R10.2a）。
//
// createSession payload 的 `clientMode` 是 additive 字段：受信 Host 盖章的可信连接模式，决定 CLI
// 是否为该会话产工具图片外置引用（ref）。本测试钉住 schema 的两值域 + 缺席语义 + 非法值拒绝，
// 以及 legacy session/create strict 面**不认识**该键（legacy 只删不增）。
import assert from "node:assert/strict";
import test from "node:test";
import { commandPayloadSchemas, parseCommandEnvelope } from "../src/acode-protocol-v4/index.js";
import { acodeSessionCreateParamsSchema } from "../src/acode-protocol/index.js";

const createSession = commandPayloadSchemas.createSession;

test("createSession.clientMode：两值域接受", () => {
  for (const clientMode of ["desktop-continuous", "web-remote-replayable"] as const) {
    const parsed = createSession.parse({ workspaceId: "ws-1", clientMode });
    assert.equal(parsed.clientMode, clientMode);
  }
});

test("createSession.clientMode：缺席接受（旧 Host/TUI/headless = fail-closed 到 inline）", () => {
  const parsed = createSession.parse({ workspaceId: "ws-1" });
  assert.equal(parsed.clientMode, undefined);
  assert.ok(!("clientMode" in parsed), "缺席时不物化出 clientMode 键");
});

test("createSession.clientMode：非法值拒绝（不接受第三态）", () => {
  assert.equal(createSession.safeParse({ workspaceId: "ws-1", clientMode: "mobile" }).success, false);
  assert.equal(createSession.safeParse({ workspaceId: "ws-1", clientMode: "" }).success, false);
});

test("additive：createSession 是 z.object（非 strict），未知键被静默丢弃而非拒绝", () => {
  // 这是 R10.2a 依赖的 fail-safe 前提——旧 CLI 读到带 clientMode 的 payload 不会解析失败，
  // 只会丢掉它不认识的键（退化为缺席=inline）。用未知键证明非 strict。
  const parsed = createSession.parse({ workspaceId: "ws-1", __unknownFutureKey: 123 });
  assert.equal(parsed.workspaceId, "ws-1");
  assert.ok(!("__unknownFutureKey" in parsed), "未知键被 z.object 丢弃（additive 兼容旧 CLI）");
});

test("legacy session/create strict 面不认识 clientMode（legacy 只删不增）", () => {
  const base = { workspace: { workspacePath: "/ws", workspaceKey: "/ws" } };
  assert.equal(acodeSessionCreateParamsSchema.safeParse(base).success, true);
  const withClientMode = acodeSessionCreateParamsSchema.safeParse({ ...base, clientMode: "desktop-continuous" });
  assert.equal(withClientMode.success, false, "legacy strict params 必须拒绝 clientMode");
});

test("parseCommandEnvelope：createSession 信封携带 clientMode 时原样通过 payload 校验", () => {
  const result = parseCommandEnvelope({
    commandId: "01890b0a-0000-7000-8000-000000000000",
    clientId: "client-1",
    sessionId: null,
    type: "createSession",
    payload: { workspaceId: "ws-1", clientMode: "desktop-continuous" },
    issuedAt: Date.now(),
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal((result.envelope.payload as { clientMode?: string }).clientMode, "desktop-continuous");
  }
});
