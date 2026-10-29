// U11 clientMode 盖章的 services 侧安全落点（spec:
// apps/acode-cli/specs/tool-media-attachment-ref.md R10.2a）。
//
// 断言分三类（仓库既有惯例，见 toolSearchModeFieldChain.test.ts / scriptWorkflowModeFieldChain.test.ts）：
//   1. 纯叶子（stampCreateSessionClientMode / resolveTrustedCommandClientMode）行为直测——覆盖语义、
//      来源纪律；
//   2. **真实 connection-scope facade + 纯叶子**的组合端到端：renderer 在 payload 里伪造
//      clientMode="desktop-continuous"、且顶层也伪造，可信连接是 web-remote-replayable ⇒ 最终盖章值
//      必为 web-remote-replayable（伪造不生效 ⇒ shouldEmitToolMediaRefs 门不开 ⇒ 不产 ref）；
//   3. 源码断言钉住装配闭包（sendConversationCommandV4 / buildConversationCommandEnvelope）确实调用
//      这两个叶子、先丢弃 wire clientMode 再最后盖章、且 legacy 面零新增。
//
// 安全模型两层：facade 的 withTrustedConnection 只删**顶层**可伪造 clientMode，**不触碰**
// envelope.payload.clientMode；本叶子层负责丢弃 + 重盖 payload 里的 clientMode。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createACodeAgentConnectionScope,
  readTrustedACodeAgentV4Connection,
  type IACodeAgentService,
} from "../src/index.js";
import {
  resolveTrustedCommandClientMode,
  stampCreateSessionClientMode,
} from "../src/acode-agent/acodeV4CreateSessionClientMode.js";
import { commandPayloadSchemas, V4_WIRE_PROTOCOL_VERSION } from "@acode/shared/acode-protocol-v4";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

// ── 1. 纯叶子行为 ──

test("stampCreateSessionClientMode：可信值**覆盖** payload 里的伪造 clientMode", () => {
  // renderer 预置了 desktop-continuous（伪造），可信连接是 web-remote-replayable。
  const forged = { workspaceId: "ws-1", clientMode: "desktop-continuous" as const };
  const stamped = stampCreateSessionClientMode(forged, "web-remote-replayable");
  assert.equal(stamped.clientMode, "web-remote-replayable", "覆盖语义：可信值写在 spread 之后");
  assert.equal(stamped.workspaceId, "ws-1", "其余字段保留");
  // 入参不被改动（envelope 是不可变事实）。
  assert.equal(forged.clientMode, "desktop-continuous", "盖章返回新对象，不改入参");
});

test("stampCreateSessionClientMode：payload 无 clientMode 时也写入可信值", () => {
  const stamped = stampCreateSessionClientMode({ workspaceId: "ws-1" }, "desktop-continuous");
  assert.equal(stamped.clientMode, "desktop-continuous");
});

test("resolveTrustedCommandClientMode：优先 trusted carrier，其次显式 params.clientMode，最终缺省", () => {
  // carrier 命中（facade 盖章的 host 真值）——即使同时有另一个 params.clientMode。
  const withCarrier = {
    clientMode: "desktop-continuous" as const,
    __acodeTrustedV4Connection: { connectionId: "c1", clientMode: "web-remote-replayable" },
  };
  assert.equal(resolveTrustedCommandClientMode(withCarrier), "web-remote-replayable");
  // 无 carrier，回退显式 params.clientMode（host 内部 adapter 直调）。
  assert.equal(resolveTrustedCommandClientMode({ clientMode: "web-remote-replayable" }), "web-remote-replayable");
  // 都无 → 缺省 desktop-continuous。
  assert.equal(resolveTrustedCommandClientMode({}), "desktop-continuous");
});

test("resolveTrustedCommandClientMode：**绝不**读 payload.clientMode（renderer 可控字段不作来源）", () => {
  // 构造一个 params：无 carrier、无顶层 clientMode，但 envelope.payload 里伪造了 desktop-continuous。
  // 若实现误读 payload，会返回 desktop-continuous；正确实现只认 carrier/顶层，此处两者皆无 → 缺省。
  // 缺省恰好是 desktop-continuous，故用「web 可信连接」版本再钉一次：carrier 是 web 时，无论 payload
  // 伪造什么都返回 web（见下条组合测试）；这里钉住「无 carrier 且顶层为 web 时不被 payload 影响」。
  const poisoned = {
    clientMode: "web-remote-replayable" as const,
    envelope: { payload: { clientMode: "desktop-continuous" } },
  } as unknown as { clientMode?: "desktop-continuous" | "web-remote-replayable" };
  assert.equal(
    resolveTrustedCommandClientMode(poisoned),
    "web-remote-replayable",
    "顶层可信 web 值胜出，payload 伪造值不被读取",
  );
});

// ── 2. 真实 facade + 纯叶子的组合端到端（安全关键）──

test("端到端安全：web-remote-replayable 可信连接下，renderer 伪造 payload+顶层 clientMode 均被压制", async () => {
  // 捕获 facade 转发给 base 的 params（withTrustedConnection 已处理过）。
  let captured: unknown = null;
  const base = {
    sendConversationCommandV4: async (params: unknown) => {
      captured = params;
      return { commandId: "cmd-1", status: "accepted" };
    },
  } as unknown as IACodeAgentService;

  const scope = createACodeAgentConnectionScope(base, {
    connectionId: "connection-1",
    // 可信连接的真值：手机/远端 = web-remote-replayable（唯一真实偏斜面，一律 inline）。
    clientMode: "web-remote-replayable",
  });
  try {
    // terminal-client 必须握手后才能发命令。
    await scope.service.helloConversationV4();
    await scope.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      clientId: "client-1",
      appVersion: "test",
    });

    // renderer 的伪造尝试：**顶层** clientMode + **payload** clientMode 都写 desktop-continuous。
    await scope.service.sendConversationCommandV4({
      workspacePath: "/ws",
      clientMode: "desktop-continuous", // 顶层伪造
      envelope: {
        commandId: "cmd-1",
        clientId: "client-1",
        sessionId: null,
        type: "createSession",
        payload: { workspaceId: "ws-1", clientMode: "desktop-continuous" }, // payload 伪造
        issuedAt: Date.now(),
      },
    } as never);

    const params = captured as Record<string, unknown> & {
      envelope: { payload: unknown };
    };
    // 第 1 层（facade）事实：顶层可伪造 clientMode 已被删；carrier 写入 host 真值 web。
    assert.equal(params.clientMode, undefined, "facade 删除顶层可伪造 clientMode");
    const carrier = readTrustedACodeAgentV4Connection(params);
    assert.equal(carrier?.clientMode, "web-remote-replayable", "carrier 携带 host 真值");
    // 关键：facade **不触碰** payload.clientMode——伪造值仍在（这正是需要本叶子层的原因）。
    const wirePayload = commandPayloadSchemas.createSession.parse(params.envelope.payload);
    assert.equal(
      wirePayload.clientMode,
      "desktop-continuous",
      "facade 未处理 payload.clientMode（伪造值仍在，需第 2 层压制）",
    );

    // 第 2 层（本叶子）：复现真实服务在 buildConversationCommandEnvelope 里的变换——
    // 解析 payload → 丢弃 wire clientMode → 用可信值最后盖章。
    const trusted = resolveTrustedCommandClientMode(params);
    const { clientMode: _forged, ...rest } = wirePayload;
    const stamped = stampCreateSessionClientMode(rest, trusted);

    // 安全不变量：最终进 CLI 的 clientMode 必为可信 web 值，伪造的 desktop-continuous 不存活。
    assert.equal(stamped.clientMode, "web-remote-replayable", "可信值胜出，伪造值被丢弃");
    assert.notEqual(
      stamped.clientMode,
      "desktop-continuous",
      "伪造的 desktop-continuous 绝不存活 ⇒ shouldEmitToolMediaRefs 门不开 ⇒ 不产 ref",
    );
  } finally {
    await scope.dispose();
  }
});

test("端到端：desktop-continuous 可信连接下，可信值同样胜出并开启门", async () => {
  let captured: unknown = null;
  const base = {
    sendConversationCommandV4: async (params: unknown) => {
      captured = params;
      return { commandId: "cmd-1", status: "accepted" };
    },
  } as unknown as IACodeAgentService;
  const scope = createACodeAgentConnectionScope(base, {
    connectionId: "connection-desktop",
    clientMode: "desktop-continuous",
  });
  try {
    await scope.service.helloConversationV4();
    await scope.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      clientId: "client-1",
      appVersion: "test",
    });
    await scope.service.sendConversationCommandV4({
      workspacePath: "/ws",
      envelope: {
        commandId: "cmd-1",
        clientId: "client-1",
        sessionId: null,
        type: "createSession",
        // renderer 什么也没伪造；可信连接就是 desktop。
        payload: { workspaceId: "ws-1" },
        issuedAt: Date.now(),
      },
    } as never);
    const params = captured as Record<string, unknown> & { envelope: { payload: unknown } };
    const trusted = resolveTrustedCommandClientMode(params);
    const wirePayload = commandPayloadSchemas.createSession.parse(params.envelope.payload);
    const { clientMode: _absent, ...rest } = wirePayload;
    const stamped = stampCreateSessionClientMode(rest, trusted);
    assert.equal(stamped.clientMode, "desktop-continuous", "受信桌面会话开启 ref 生产门");
  } finally {
    await scope.dispose();
  }
});

// ── 3. 源码断言：装配闭包确实这样接线 ──

test("sendConversationCommandV4：commandClientMode 单源自 resolveTrustedCommandClientMode（不内联、不读 payload）", () => {
  const source = readSource("../src/acode-agent/acodeAgentService.ts");
  assert.match(
    source,
    /const commandClientMode = resolveTrustedCommandClientMode\(params\);/,
    "commandClientMode 必须走导出的纯叶子（可单测），不再内联 ?? 链",
  );
  assert.match(
    source,
    /buildConversationCommandEnvelope\(params, commandClientMode\)/,
    "createSession 信封必须收到可信 commandClientMode 作盖章来源",
  );
});

test("buildConversationCommandEnvelope：先丢弃 wire clientMode，再用 stampCreateSessionClientMode 最后盖章", () => {
  const source = readSource("../src/acode-agent/acodeAgentService.ts");
  const region = source.slice(
    source.indexOf("async function buildConversationCommandEnvelope"),
    source.indexOf('if (envelope.type !== "sendText") return envelope;'),
  );
  assert.ok(region.length > 0, "createSession 分支区域存在");
  assert.match(
    region,
    /const \{ clientMode: _forgedClientMode, \.\.\.payload \} = parsedPayload;/,
    "必须从解析后的 payload 里剔除 wire clientMode（renderer 可控字段不作来源）",
  );
  assert.match(
    region,
    /stampCreateSessionClientMode\(withHostFlags, commandClientMode\)/,
    "clientMode 必须在 host flag 装配之后最后盖章（覆盖语义，伪造值永不存活）",
  );
  assert.match(
    region,
    /commandClientMode === undefined\s*\n?\s*\? withHostFlags/,
    "可信值缺席 = 不盖章 = 保持剔除结果 = CLI 侧缺席即 inline（fail-closed）",
  );
});

test("legacy 面零新增：session create/resume 参数构造不携带 clientMode（legacy 只删不增）", () => {
  const source = readSource("../src/acode-agent/acodeAgentService.ts");
  // M2-3：legacy session/create|resume wire 面整体删除（v4 化完成），buildSessionCreateParams/
  // buildSessionResumeParams 随之移除——「不携带 clientMode」由删除承载，比区域扫描更强。
  assert.equal(
    source.indexOf("function buildSessionCreateParams"),
    -1,
    "legacy create 参数构造已随 M2-3 删除",
  );
  assert.equal(
    source.indexOf("function buildSessionResumeParams"),
    -1,
    "legacy resume 参数构造已随 M2-3 删除",
  );
});
