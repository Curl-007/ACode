import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const shared = await import("../src/acode-protocol-shared.ts");
const legacy = await import("../src/acode-protocol/index.ts");
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
