// U11 工具图片 ref 的**读取授权矩阵**守护测试
// （specs: apps/acode-cli/specs/tool-media-attachment-ref.md R3 / 验收场景 U11-A3）。
//
// 授权判据全在 resolveAuthorizedToolMedia 这个纯函数叶子里（v4-gateway 只做 row 扫描的接线），
// 因此这里直接对授权矩阵单测，无需构造完整 gateway + host 桩——判据即安全不变量：
//   - 跨 session / 跨 workspace 的 ref ⇒ 拒绝（null）；
//   - 伪造 target（ref 不在任何权威 toolCall row 的 display 里）⇒ 拒绝；
//   - ref 只出现在模型可控文本（output.text / markdown）里 ⇒ **不**构成授权；
//   - 形态非法 ref（traversal / ADS / 裸路径）⇒ 在授权比对前就被挡；
//   - 命中后 mime/bytes 取**行上的**值，不采信 renderer 自报。
import assert from "node:assert/strict";
import test from "node:test";

const {
  resolveAuthorizedToolMedia,
  toolMediaRefBelongsToSession,
} = await import(
  "../packages/bootstrap/src/acode-protocol-v4/tool-media-authorization.ts"
);

const SESSION = "sess-owner";
const OTHER_SESSION = "sess-intruder";

/** 一条携带 ref 形态 node_repl_images display 的权威 toolCall row。 */
function toolRowWithRef(ref, { mimeType = "image/png", bytes = 1234, rowId = 7 } = {}) {
  return {
    rowId,
    entityId: `tc-${rowId}`,
    kind: "toolCall",
    toolCallId: `tc-${rowId}`,
    toolName: "mcp__node_repl__js",
    status: "success",
    inputText: "{}",
    display: {
      kind: "node_repl_images",
      images: [{ ref, mimeType, bytes }],
    },
  };
}

/** 一条 inline base64 形态的 row（字节已在 row，不参与按需授权）。 */
function toolRowWithInline({ rowId = 9 } = {}) {
  return {
    rowId,
    entityId: `tc-${rowId}`,
    kind: "toolCall",
    toolCallId: `tc-${rowId}`,
    toolName: "mcp__node_repl__js",
    status: "success",
    inputText: "{}",
    display: {
      kind: "node_repl_images",
      images: [{ base64: "aGVsbG8=", mimeType: "image/png" }],
    },
  };
}

const OWNER_REF = `acode-artifact://${encodeURIComponent(SESSION)}/art-001`;
const INTRUDER_REF = `acode-artifact://${encodeURIComponent(OTHER_SESSION)}/art-001`;

test("U11-A3: 本 session 的权威工具 ref 命中授权，返回行上的 mime/bytes", () => {
  const rows = [toolRowWithRef(OWNER_REF, { mimeType: "image/jpeg", bytes: 4242 })];
  const result = resolveAuthorizedToolMedia({ rows, sessionId: SESSION, ref: OWNER_REF });
  assert.ok(result);
  // 命中的 mime/bytes 来自 row，不是 renderer 自报——这是「不采信自报 MIME」的落点。
  assert.equal(result.mime, "image/jpeg");
  assert.equal(result.bytes, 4242);
  // 归一成 AttachmentRef：ref 原样回带（喂给既有 readAttachmentPayload），展示名固定。
  assert.equal(result.ref, OWNER_REF);
  assert.equal(result.fileName, "tool-image");
});

test("U11-A3: 跨 session 的 ref 被拒（另一个 session 的权威 row 也不放行）", () => {
  // 即便投影里存在 intruder session 的 row，只要请求方 session 是 OWNER，就不授权 intruder ref。
  const rows = [toolRowWithRef(INTRUDER_REF)];
  assert.equal(
    resolveAuthorizedToolMedia({ rows, sessionId: SESSION, ref: INTRUDER_REF }),
    null,
  );
  // 反向：请求方是 intruder，但 ref 归属 owner —— authority 不匹配，拒绝。
  assert.equal(
    resolveAuthorizedToolMedia({ rows: [toolRowWithRef(OWNER_REF)], sessionId: OTHER_SESSION, ref: OWNER_REF }),
    null,
  );
});

test("U11-A3: 伪造 target（ref 不在任何权威 toolCall row 的 display 里）被拒", () => {
  const rows = [toolRowWithRef(OWNER_REF)];
  const forgedRef = `acode-artifact://${encodeURIComponent(SESSION)}/art-999`;
  assert.equal(
    resolveAuthorizedToolMedia({ rows, sessionId: SESSION, ref: forgedRef }),
    null,
  );
});

test("U11-A3: 模型可控文本里出现 ref 不构成授权（output.text / assistantText）", () => {
  // 一条 assistantText row，正文里写着 OWNER_REF；另一条 userInput row，附件名里含 OWNER_REF。
  // 授权只认 toolCall.display.images[].ref 的逐字命中，文本里的出现一律不算。
  const rows = [
    {
      rowId: 1,
      entityId: "txt-1",
      kind: "assistantText",
      text: `![img](${OWNER_REF})`,
      state: "complete",
    },
    {
      rowId: 2,
      entityId: "usr-2",
      kind: "userInput",
      text: OWNER_REF,
      attachments: [],
    },
  ];
  assert.equal(
    resolveAuthorizedToolMedia({ rows, sessionId: SESSION, ref: OWNER_REF }),
    null,
  );
});

test("U11-A3: inline base64 row 不产生按需授权（字节已在 row，无 ref 可读）", () => {
  const rows = [toolRowWithInline()];
  // inline 图片没有 ref；即便用一个形态合法的 owner ref 请求，也不会命中这条 row。
  assert.equal(
    resolveAuthorizedToolMedia({ rows, sessionId: SESSION, ref: OWNER_REF }),
    null,
  );
});

test("U11-A3: 形态非法 ref 在授权比对前被挡（traversal / ADS / 裸路径 / 错误 scheme）", () => {
  const rows = [toolRowWithRef(OWNER_REF)];
  const malformed = [
    "acode-artifact://sess-owner/../../etc/passwd", // traversal
    "acode-artifact://sess-owner/art:stream", // Windows ADS
    "file:///etc/passwd", // 错误 scheme（任意路径读取）
    "/etc/passwd", // 裸路径
    "acode-artifact://sess-owner/art\0.png", // NUL
    "acode-artifact://sess-owner\\art", // 反斜杠
  ];
  for (const ref of malformed) {
    assert.equal(
      resolveAuthorizedToolMedia({ rows, sessionId: SESSION, ref }),
      null,
      `形态非法 ref 应被拒：${JSON.stringify(ref)}`,
    );
  }
});

test("U11-A3: 空投影 / 非 toolCall row 命中不了授权", () => {
  assert.equal(resolveAuthorizedToolMedia({ rows: [], sessionId: SESSION, ref: OWNER_REF }), null);
  const nonToolRows = [
    { rowId: 3, entityId: "h-3", kind: "turnHeader", turnId: "t", turnNumber: 1, title: "x" },
  ];
  assert.equal(
    resolveAuthorizedToolMedia({ rows: nonToolRows, sessionId: SESSION, ref: OWNER_REF }),
    null,
  );
});

test("U11-A3: 多条 row 里精确命中携带该 ref 的那一条", () => {
  const otherRef = `acode-artifact://${encodeURIComponent(SESSION)}/art-002`;
  const rows = [
    toolRowWithRef(otherRef, { rowId: 5, mimeType: "image/gif", bytes: 100 }),
    toolRowWithRef(OWNER_REF, { rowId: 6, mimeType: "image/webp", bytes: 200 }),
  ];
  const result = resolveAuthorizedToolMedia({ rows, sessionId: SESSION, ref: OWNER_REF });
  assert.equal(result?.mime, "image/webp");
  assert.equal(result?.bytes, 200);
});

// ── toolMediaRefBelongsToSession：形态 + session 绑定的组合判据 ──

test("U11-A3: belongsToSession 同时校验形态与 authority", () => {
  assert.equal(toolMediaRefBelongsToSession(OWNER_REF, SESSION), true);
  assert.equal(toolMediaRefBelongsToSession(OWNER_REF, OTHER_SESSION), false);
  assert.equal(toolMediaRefBelongsToSession(INTRUDER_REF, SESSION), false);
  // 形态非法即便 authority 前缀看着对，也先被形态门挡掉。
  assert.equal(
    toolMediaRefBelongsToSession(`acode-artifact://${encodeURIComponent(SESSION)}/../x`, SESSION),
    false,
  );
  assert.equal(toolMediaRefBelongsToSession("file:///x", SESSION), false);
  assert.equal(toolMediaRefBelongsToSession(123, SESSION), false);
});
