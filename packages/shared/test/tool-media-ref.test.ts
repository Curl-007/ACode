// U11 工具图片受授权附件引用的 shared 契约守护测试
// （specs: apps/acode-cli/specs/tool-media-attachment-ref.md 场景 A-ref / A-inline / A-strict）。
//
// 钉住四条不变量：
// 1. ref 形态的 `.strict()`——未知/多余字段被拒（含 base64+ref 同时出现、敏感字段名）；
// 2. ref 不能承载 traversal（`..`）、绝对路径/裸路径、Windows ADS 冒号、NUL、反斜杠、错误 scheme；
// 3. inline base64 形态仍受既有 200 KiB / 最多 2 张上限约束（U11 不提高生产上限）；
// 4. `inspectToolMediaRef` 的拒绝分类是**可证明**的稳定 code（gateway 授权与降级文案据此分流）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TOOL_MEDIA_MAX_IMAGES,
  TOOL_MEDIA_MAX_INLINE_BASE64_CHARS,
  TOOL_MEDIA_REF_REJECTIONS,
  inspectToolMediaRef,
  isToolMediaRefImage,
  toolMediaImageSchema,
  toolMediaRefSchema,
} from "../src/acode-protocol-v4/tool-media-ref.js";
import { toolCallDisplaySchema } from "../src/acode-protocol-v4/toolDisplay.js";

/** 一个形态合法的 ref（authority=encodeURIComponent(sessionId)，path=artifactId）。 */
const VALID_REF = "acode-artifact://sess-abc/art-001";

function refImage(overrides: Record<string, unknown> = {}) {
  return {
    ref: VALID_REF,
    mimeType: "image/png",
    bytes: 12_345,
    ...overrides,
  };
}

function inlineImage(overrides: Record<string, unknown> = {}) {
  return {
    base64: "aGVsbG8=",
    mimeType: "image/png",
    ...overrides,
  };
}

// ── 1. ref 形态 .strict()：未知字段被拒 ──

test("A-ref: 合法 ref 形态通过，且逐字段回读一致", () => {
  const parsed = toolMediaImageSchema.parse(refImage({ width: 640, height: 480 }));
  assert.ok(isToolMediaRefImage(parsed));
  assert.equal(parsed.ref, VALID_REF);
  assert.equal(parsed.bytes, 12_345);
  assert.equal(parsed.width, 640);
});

test("A-strict: ref 形态拒绝未知/多余字段（.strict 白名单）", () => {
  assert.throws(() => toolMediaImageSchema.parse(refImage({ unexpected: 1 })));
  // 敏感字段名同样在 parse 时被拒，不靠生产侧自律。
  for (const forbidden of ["apiKey", "token", "authorization", "path", "absolutePath"]) {
    assert.throws(
      () => toolMediaImageSchema.parse(refImage({ [forbidden]: "x" })),
      undefined,
      `ref 形态应拒绝未知字段 ${forbidden}`,
    );
  }
});

test("A-strict: 一张图片不能同时携带 base64 与 ref（两分支互斥）", () => {
  // union 的两个分支各自 .strict()：既带 base64 又带 ref 的对象在两个分支都失败 → 整块拒。
  assert.throws(() =>
    toolMediaImageSchema.parse({
      ref: VALID_REF,
      base64: "aGVsbG8=",
      mimeType: "image/png",
      bytes: 5,
    }),
  );
});

// ── 2. ref 不能承载 traversal / 绝对路径 / ADS / NUL / 反斜杠 ──

test("A-ref: inspectToolMediaRef 对合法 artifact ref 返回 null", () => {
  assert.equal(inspectToolMediaRef(VALID_REF), null);
});

test("A-ref: 拒绝非 acode-artifact scheme、裸路径、绝对路径", () => {
  const cases: Array<[string, string]> = [
    ["file:///etc/passwd", TOOL_MEDIA_REF_REJECTIONS.wrongScheme],
    ["/etc/passwd", TOOL_MEDIA_REF_REJECTIONS.wrongScheme],
    ["C:\\Users\\x\\secret.png", TOOL_MEDIA_REF_REJECTIONS.backslash],
    ["http://evil/x.png", TOOL_MEDIA_REF_REJECTIONS.wrongScheme],
    ["acode-artifactx://sess/art", TOOL_MEDIA_REF_REJECTIONS.wrongScheme],
  ];
  for (const [ref, expected] of cases) {
    assert.equal(inspectToolMediaRef(ref), expected, `应拒绝 ${ref}`);
  }
});

test("A-ref: 拒绝 traversal（.. 段），但不拒绝 a..b 这类合法片段", () => {
  assert.equal(
    inspectToolMediaRef("acode-artifact://sess/../../etc/passwd"),
    TOOL_MEDIA_REF_REJECTIONS.traversal,
  );
  assert.equal(
    inspectToolMediaRef("acode-artifact://../other-sess/art"),
    TOOL_MEDIA_REF_REJECTIONS.traversal,
  );
  assert.equal(inspectToolMediaRef("acode-artifact://sess/art..001"), null);
});

test("A-ref: 拒绝 NUL、反斜杠、Windows ADS 裸冒号", () => {
  assert.equal(
    inspectToolMediaRef("acode-artifact://sess/art\0.png"),
    TOOL_MEDIA_REF_REJECTIONS.nul,
  );
  assert.equal(
    inspectToolMediaRef("acode-artifact://sess\\art"),
    TOOL_MEDIA_REF_REJECTIONS.backslash,
  );
  // scheme 分隔符之外的裸冒号（authority 或 path 段）= ADS / 第二 scheme，拒绝。
  assert.equal(
    inspectToolMediaRef("acode-artifact://sess/art:stream"),
    TOOL_MEDIA_REF_REJECTIONS.adsColon,
  );
  assert.equal(
    inspectToolMediaRef("acode-artifact://se:ss/art"),
    TOOL_MEDIA_REF_REJECTIONS.adsColon,
  );
});

test("A-ref: 拒绝空 authority / 空 path / 空串 / 非字符串 / 超长", () => {
  assert.equal(
    inspectToolMediaRef("acode-artifact:///art"),
    TOOL_MEDIA_REF_REJECTIONS.emptyAuthority,
  );
  assert.equal(inspectToolMediaRef("acode-artifact://sess/"), TOOL_MEDIA_REF_REJECTIONS.emptyPath);
  assert.equal(inspectToolMediaRef("acode-artifact://sess"), TOOL_MEDIA_REF_REJECTIONS.emptyPath);
  assert.equal(inspectToolMediaRef(""), TOOL_MEDIA_REF_REJECTIONS.empty);
  assert.equal(inspectToolMediaRef(42), TOOL_MEDIA_REF_REJECTIONS.notString);
  assert.equal(
    inspectToolMediaRef(`acode-artifact://sess/${"a".repeat(5000)}`),
    TOOL_MEDIA_REF_REJECTIONS.tooLong,
  );
});

test("A-ref: toolMediaRefSchema 在协议校验层拒绝形态非法 ref", () => {
  assert.throws(() => toolMediaRefSchema.parse("file:///etc/passwd"));
  assert.throws(() => toolMediaRefSchema.parse("acode-artifact://sess/../../x"));
  assert.equal(toolMediaRefSchema.parse(VALID_REF), VALID_REF);
});

test("A-strict: display union 里 ref 形态非法 → 整块 node_repl_images display 被拒", () => {
  const parsed = toolCallDisplaySchema.safeParse({
    kind: "node_repl_images",
    images: [refImage({ ref: "file:///etc/passwd" })],
  });
  assert.equal(parsed.success, false);
});

// ── 3. inline base64 形态仍受既有上限约束 ──

test("A-inline: 合法 inline 形态通过，且 isToolMediaRefImage=false", () => {
  const parsed = toolMediaImageSchema.parse(inlineImage());
  assert.equal(isToolMediaRefImage(parsed), false);
  assert.equal("base64" in parsed, true);
});

test("A-inline: base64 超过 200 KiB 字符上限被拒（不提高生产上限）", () => {
  const oversized = "a".repeat(TOOL_MEDIA_MAX_INLINE_BASE64_CHARS + 1);
  assert.throws(() => toolMediaImageSchema.parse(inlineImage({ base64: oversized })));
  // 恰好在上限内通过。
  const atLimit = "a".repeat(TOOL_MEDIA_MAX_INLINE_BASE64_CHARS);
  assert.doesNotThrow(() => toolMediaImageSchema.parse(inlineImage({ base64: atLimit })));
});

test("A-inline: 空 base64 与非 image mime 被拒", () => {
  assert.throws(() => toolMediaImageSchema.parse(inlineImage({ base64: "" })));
  assert.throws(() => toolMediaImageSchema.parse(inlineImage({ mimeType: "application/pdf" })));
});

test("A-inline: ref 形态 bytes 必须为正且 ≤ 附件上限", () => {
  assert.throws(() => toolMediaImageSchema.parse(refImage({ bytes: 0 })));
  assert.throws(() => toolMediaImageSchema.parse(refImage({ bytes: -1 })));
});

// ── 4. node_repl_images display 的图片数量上限（≤2，U11 不提高）──

test("A-inline: display 最多接受 2 张图片，第 3 张被拒", () => {
  const two = toolCallDisplaySchema.safeParse({
    kind: "node_repl_images",
    images: [inlineImage(), inlineImage({ mimeType: "image/jpeg" })],
  });
  assert.equal(two.success, true);
  assert.equal(TOOL_MEDIA_MAX_IMAGES, 2);
  const three = toolCallDisplaySchema.safeParse({
    kind: "node_repl_images",
    images: [inlineImage(), inlineImage(), inlineImage()],
  });
  assert.equal(three.success, false);
});

test("A-ref: display 可混合 inline 与 ref 形态（各按自身分支校验）", () => {
  const parsed = toolCallDisplaySchema.safeParse({
    kind: "node_repl_images",
    images: [inlineImage(), refImage()],
  });
  assert.equal(parsed.success, true);
});

test("A-inline: 纯动作 cell（无 images、仅 app）仍合法（向后兼容）", () => {
  const parsed = toolCallDisplaySchema.safeParse({
    kind: "node_repl_images",
    app: { appKey: "darwin:com.example.app" },
    source: "browser_turn_end",
  });
  assert.equal(parsed.success, true);
});
