import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const shared = await import("../src/acode-protocol-shared.ts");
const legacy = await import("../src/acode-protocol/index.ts");
const legacyTypes = await import("../src/acode-protocol-legacy-types.ts");
const v4 = await import("../src/acode-protocol-v4/command.ts");
const v4Transport = await import("../src/acode-protocol-v4/transport.ts");

const mcpServer = {
  name: "local",
  command: "node",
  args: ["server.mjs"],
  env: [],
};

test("legacy and v4 consume the neutral MCP/browser schema without changing validation", () => {
  assert.equal(shared.acodeProtocolMcpServerSchema.safeParse(mcpServer).success, true);
  assert.equal(legacy.acodeProtocolMcpServerSchema.safeParse(mcpServer).success, true);
  assert.equal(
    v4.commandPayloadSchemas.createSession.safeParse({
      workspaceId: "workspace-1",
      mcpServers: [mcpServer],
    }).success,
    true,
  );

  const ambient = { tabCount: 1, currentUrl: "https://example.test/" };
  assert.equal(shared.acodeBrowserAmbientContextSchema.safeParse(ambient).success, true);
  assert.equal(legacy.acodeBrowserAmbientContextSchema.safeParse(ambient).success, true);
  assert.equal(
    v4.commandPayloadSchemas.sendText.safeParse({ text: "hello", browserAmbientContext: ambient })
      .success,
    true,
  );
});

test("v4 command has no reverse import into the legacy protocol barrel", async () => {
  const source = await readFile(
    new URL("../src/acode-protocol-v4/command.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /acode-protocol\/index(?:\.js|\.ts)?/);
  assert.match(source, /acode-protocol-shared\.js/);
});

test("neutral schema module has no protocol-directory dependency", async () => {
  const source = await readFile(
    new URL("../src/acode-protocol-shared.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /acode-protocol(?:-v4)?[\\/]/);
});

test("session subscription dual-delivery contract keeps legacy replay separate from v4 frames", () => {
  // Legacy session/subscribe returns an event-seq cursor and optionally embeds a snapshot in
  // the response. Its delivery kind names the old stream selector, even though the strings
  // happen to match the v4 client profiles.
  const legacyOnline = legacy.acodeSessionSubscribeParamsSchema.parse({
    sessionId: "session-1",
    deliveryKind: "desktop-continuous",
    afterSeq: 7,
    includeSnapshot: false,
  });
  const legacyReplayable = legacy.acodeSessionSubscribeParamsSchema.parse({
    sessionId: "session-1",
    deliveryKind: "web-remote-replayable",
    includeSnapshot: true,
  });
  assert.equal(legacyOnline.deliveryKind, "desktop-continuous");
  assert.equal(legacyReplayable.includeSnapshot, true);

  // v4 uses a topic/logEpoch/seq watermark and an attachment-owned connection. Both
  // desktop-continuous and web-remote-replayable use the same request shape; the trusted host
  // injects clientMode and connectionId before forwarding it to the CLI.
  const v4Desktop = v4Transport.v4ConversationSubscribeParamsSchema.parse({
    topic: "conversation/session-1",
    connectionId: "connection-desktop",
    clientMode: "desktop-continuous",
    base: { logEpoch: "epoch-1", seq: 7 },
    visibility: "foreground",
  });
  const v4Remote = v4Transport.v4ConversationSubscribeParamsSchema.parse({
    topic: "conversation/session-1",
    connectionId: "connection-mobile",
    clientMode: "web-remote-replayable",
    visibility: "background",
  });
  assert.equal(v4Desktop.clientMode, "desktop-continuous");
  assert.equal(v4Remote.clientMode, "web-remote-replayable");

  // The response boundary is intentionally different: v4 ACK is followed by an owned
  // conversation/frame notification. Embedding legacy events in the ACK would violate the
  // v4 response schema and lose the post-response ordering guarantee.
  const ack = {
    ack: { subscriptionId: "subscription-1", mode: "resume", logEpoch: "epoch-1" },
  };
  assert.deepEqual(v4Transport.v4ConversationSubscribeResultSchema.parse(ack), ack);
  assert.equal(
    v4Transport.v4ConversationSubscribeResultSchema.safeParse({
      ...ack,
      sessionId: "session-1",
      eventSeq: 7,
      events: [],
    }).success,
    false,
    "v4 subscribe ACK must stay separate from legacy event replay payload",
  );
  assert.equal(
    legacy.acodeSessionSubscribeResultSchema.safeParse(ack).success,
    false,
    "legacy session/subscribe consumers must not be handed a v4 ACK",
  );
});

// M2-1 裁决（2026-10-28，默认裁决产品可推翻，见 docs/reviews/2026-10-28/m2-scoping.md §6.3）：
// ① switchCollaborationMode 值域补 auto——legacy session/setMode 接受 auto
//    （acodeSessionModeSchema 含 auto），v4 刻意排除会收窄 legacy 能力；补值 = 放宽，向后兼容。
// ② compact payload 加可选 instructions——不丢 legacy session/compact 的 instructions 字段。
test("v4 switchCollaborationMode accepts auto alongside the user-switchable modes", () => {
  for (const mode of ["build", "edit", "plan", "yolo", "dontAsk", "auto"]) {
    assert.equal(
      v4.commandPayloadSchemas.switchCollaborationMode.safeParse({ mode }).success,
      true,
      `mode=${mode} must parse`,
    );
  }
  // 值域与 legacy acodeSessionModeSchema 逐字一致：session/setMode → switchCollaborationMode
  // 迁移（M2-1）不丢任何 legacy 可表达值。
  assert.deepEqual(
    [...legacyTypes.acodeSessionModeSchema.options].sort(),
    ["auto", "build", "dontAsk", "edit", "plan", "yolo"],
  );
  assert.deepEqual(
    [...v4.commandPayloadSchemas.switchCollaborationMode.shape.mode.options].sort(),
    [...legacyTypes.acodeSessionModeSchema.options].sort(),
    "v4 switchCollaborationMode 值域必须与 legacy acodeSessionModeSchema 逐字一致",
  );
  assert.equal(
    v4.commandPayloadSchemas.switchCollaborationMode.safeParse({ mode: "unknown-mode" }).success,
    false,
    "unknown modes must stay rejected",
  );
  assert.equal(
    v4.commandPayloadSchemas.switchCollaborationMode.safeParse({}).success,
    false,
    "mode is required",
  );
});

test("v4 compact payload carries optional instructions without losing the empty form", () => {
  assert.equal(v4.commandPayloadSchemas.compact.safeParse({}).success, true);
  const withInstructions = v4.commandPayloadSchemas.compact.parse({
    instructions: "保留与 TODO 相关的上下文",
  });
  assert.equal(withInstructions.instructions, "保留与 TODO 相关的上下文");
  assert.equal(
    v4.commandPayloadSchemas.compact.safeParse({ instructions: 42 }).success,
    false,
    "instructions must be a string when present",
  );
});
