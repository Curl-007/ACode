// U11 契约镜像守护：shared(zod v4) 与 contracts(zod v3) 对 `node_repl_images` 的 images
// 成员必须给出**相同**的接受/拒绝结论。
// （spec: apps/acode-cli/specs/tool-media-attachment-ref.md R10.5 / 验收 U11-P8）
//
// 为什么需要：contracts 是 zod v3、shared 是 zod v4，**不能**跨包复用同一个 schema 对象，
// 只能镜像。镜像就意味着可能漂移——一侧改了界而另一侧没跟上，display 会在一侧被整块剥掉
// （该文件自己的 `providerStop` 事故注释就是同款）。本测试把「两侧必须同形」机械化。
//
// 先例：tests/provider-diagnostics-contract-parity.test.mjs（同为跨包镜像守护）。
import assert from "node:assert/strict";
import test from "node:test";

// CLI 测试目录不解析裸 @acode/shared（pnpm 未提升到 apps/acode-cli），走相对路径。
const {
  toolMediaImageSchema,
  toolMediaInlineImageSchema,
  toolMediaRefImageSchema,
  TOOL_MEDIA_MAX_INLINE_BASE64_CHARS,
  TOOL_MEDIA_MAX_DIMENSION,
  TOOL_MEDIA_REF_MAX_CHARS,
  PROTOCOL_V4_LIMITS,
} = await import("../../../packages/shared/src/acode-protocol-v4/index.ts");
const { toolCallDisplaySchema } =
  await import("../../../packages/shared/src/acode-protocol-v4/index.ts");
// node_repl_images 的镜像 schema 抽到了独立叶子 node-repl-display.ts；
// union 汇聚点（toolResultDisplayPayloadSchema）仍在 tool-result-metadata.ts。
const { nodeReplImageToolResultDisplayPayloadSchema } =
  await import("../packages/contracts/src/tools/node-repl-display.ts");
const { toolResultDisplayPayloadSchema } =
  await import("../packages/contracts/src/tools/tool-result-metadata.ts");

const VALID_REF = `acode-artifact://${encodeURIComponent("sess-1")}/tool-result-abc`;
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).toString("base64");

/**
 * 正/负样本表：每条是一个 images 成员，标注**预期**是否被接受。
 * 两份 schema 必须都给出这个结论——任何一侧单方面改界都会在这里暴露。
 */
const IMAGE_SAMPLES = [
  // ── inline 分支（legacy，逐字不动）──
  {
    name: "inline: 合法 base64 + image mime",
    image: { base64: PNG_B64, mimeType: "image/png" },
    accept: true,
  },
  {
    name: "inline: base64 恰好在上限内",
    image: { base64: "A".repeat(TOOL_MEDIA_MAX_INLINE_BASE64_CHARS), mimeType: "image/png" },
    accept: true,
  },
  {
    name: "inline: base64 超上限 1 字符 → 拒",
    image: { base64: "A".repeat(TOOL_MEDIA_MAX_INLINE_BASE64_CHARS + 1), mimeType: "image/png" },
    accept: false,
  },
  { name: "inline: 空 base64 → 拒", image: { base64: "", mimeType: "image/png" }, accept: false },
  {
    name: "inline: 非 image mime → 拒",
    image: { base64: PNG_B64, mimeType: "text/plain" },
    accept: false,
  },
  { name: "inline: 缺 mimeType → 拒", image: { base64: PNG_B64 }, accept: false },
  {
    name: "inline: 多余字段 → 拒（strict）",
    image: { base64: PNG_B64, mimeType: "image/png", extra: 1 },
    accept: false,
  },

  // ── ref 分支（U11 新增）──
  {
    name: "ref: 合法最小集",
    image: { ref: VALID_REF, mimeType: "image/png", bytes: 1024 },
    accept: true,
  },
  {
    name: "ref: 带 width/height/sha256",
    image: {
      ref: VALID_REF,
      mimeType: "image/png",
      bytes: 1024,
      width: 800,
      height: 600,
      sha256: "a".repeat(64),
    },
    accept: true,
  },
  {
    name: "ref: bytes=0 → 拒（positive）",
    image: { ref: VALID_REF, mimeType: "image/png", bytes: 0 },
    accept: false,
  },
  {
    name: "ref: bytes 超 attachmentMaxBytes → 拒",
    image: {
      ref: VALID_REF,
      mimeType: "image/png",
      bytes: PROTOCOL_V4_LIMITS.attachmentMaxBytes + 1,
    },
    accept: false,
  },
  {
    name: "ref: bytes 非整数 → 拒",
    image: { ref: VALID_REF, mimeType: "image/png", bytes: 1.5 },
    accept: false,
  },
  {
    name: "ref: width 超 TOOL_MEDIA_MAX_DIMENSION → 拒",
    image: {
      ref: VALID_REF,
      mimeType: "image/png",
      bytes: 10,
      width: TOOL_MEDIA_MAX_DIMENSION + 1,
    },
    accept: false,
  },
  {
    name: "ref: sha256 非 64 hex → 拒",
    image: { ref: VALID_REF, mimeType: "image/png", bytes: 10, sha256: "abc" },
    accept: false,
  },
  {
    name: "ref: 缺 bytes → 拒（必填）",
    image: { ref: VALID_REF, mimeType: "image/png" },
    accept: false,
  },

  // ── ref 形态门（inspectToolMediaRef 共用判据）──
  {
    name: "ref: 裸路径 → 拒（wrong_scheme）",
    image: { ref: "/etc/passwd", mimeType: "image/png", bytes: 10 },
    accept: false,
  },
  {
    name: "ref: file:// → 拒（wrong_scheme）",
    image: { ref: "file:///etc/passwd", mimeType: "image/png", bytes: 10 },
    accept: false,
  },
  {
    name: "ref: traversal 段 → 拒",
    image: {
      ref: `acode-artifact://${encodeURIComponent("s")}/../other/x`,
      mimeType: "image/png",
      bytes: 10,
    },
    accept: false,
  },
  {
    name: "ref: 反斜杠 → 拒",
    image: { ref: "acode-artifact://s/a\\b", mimeType: "image/png", bytes: 10 },
    accept: false,
  },
  {
    name: "ref: NUL → 拒",
    image: { ref: "acode-artifact://s/a\0b", mimeType: "image/png", bytes: 10 },
    accept: false,
  },
  {
    name: "ref: authority 裸冒号（ADS）→ 拒",
    image: { ref: "acode-artifact://s:stream/x", mimeType: "image/png", bytes: 10 },
    accept: false,
  },
  {
    name: "ref: path 裸冒号（ADS）→ 拒",
    image: { ref: "acode-artifact://s/a:b", mimeType: "image/png", bytes: 10 },
    accept: false,
  },
  {
    name: "ref: 空 authority → 拒",
    image: { ref: "acode-artifact:///x", mimeType: "image/png", bytes: 10 },
    accept: false,
  },
  {
    name: "ref: 空 path → 拒",
    image: { ref: "acode-artifact://s/", mimeType: "image/png", bytes: 10 },
    accept: false,
  },
  {
    name: "ref: 超 TOOL_MEDIA_REF_MAX_CHARS → 拒",
    image: {
      ref: `acode-artifact://s/${"a".repeat(TOOL_MEDIA_REF_MAX_CHARS)}`,
      mimeType: "image/png",
      bytes: 10,
    },
    accept: false,
  },
  {
    name: "ref: 合法 id 含 a..b 片段（非完整段）→ 接受",
    image: { ref: "acode-artifact://s/a..b/x", mimeType: "image/png", bytes: 10 },
    accept: true,
  },

  // ── 互斥（union 两分支各自 strict）──
  {
    name: "互斥: 既带 base64 又带 ref → 拒",
    image: { base64: PNG_B64, ref: VALID_REF, mimeType: "image/png", bytes: 10 },
    accept: false,
  },
];

test("镜像守护：shared 与 contracts 对每条 images 样本给出相同结论", () => {
  const mismatches = [];
  for (const sample of IMAGE_SAMPLES) {
    // shared：union 直接判单张图片。
    const sharedAccept = toolMediaImageSchema.safeParse(sample.image).success;
    // contracts：镜像是 display 的 images 成员，包一层 display 判（union 的 strict 行为一致）。
    const contractsDisplay = { kind: "node_repl_images", images: [sample.image] };
    const contractsAccept =
      nodeReplImageToolResultDisplayPayloadSchema.safeParse(contractsDisplay).success;

    if (sharedAccept !== sample.accept) {
      mismatches.push(
        `[shared 与预期不符] ${sample.name}: 期望 ${sample.accept} 实得 ${sharedAccept}`,
      );
    }
    if (contractsAccept !== sample.accept) {
      mismatches.push(
        `[contracts 与预期不符] ${sample.name}: 期望 ${sample.accept} 实得 ${contractsAccept}`,
      );
    }
    if (sharedAccept !== contractsAccept) {
      mismatches.push(
        `[两侧漂移] ${sample.name}: shared=${sharedAccept} contracts=${contractsAccept}`,
      );
    }
  }
  assert.deepEqual(mismatches, [], mismatches.join("\n"));
});

test("样本表本身有区分度：正例与负例都非空", () => {
  const accepted = IMAGE_SAMPLES.filter((s) => s.accept).length;
  const rejected = IMAGE_SAMPLES.filter((s) => !s.accept).length;
  assert.ok(accepted >= 5, `正例过少: ${accepted}`);
  assert.ok(rejected >= 15, `负例过少: ${rejected}`);
});

test("inline 分支界逐字一致：两侧对上限/超限给出同结论（A4 向后兼容）", () => {
  const atLimit = { base64: "A".repeat(TOOL_MEDIA_MAX_INLINE_BASE64_CHARS), mimeType: "image/png" };
  const overLimit = {
    base64: "A".repeat(TOOL_MEDIA_MAX_INLINE_BASE64_CHARS + 1),
    mimeType: "image/png",
  };
  assert.ok(toolMediaInlineImageSchema.safeParse(atLimit).success);
  assert.ok(
    nodeReplImageToolResultDisplayPayloadSchema.safeParse({
      kind: "node_repl_images",
      images: [atLimit],
    }).success,
  );
  assert.ok(!toolMediaInlineImageSchema.safeParse(overLimit).success);
  assert.ok(
    !nodeReplImageToolResultDisplayPayloadSchema.safeParse({
      kind: "node_repl_images",
      images: [overLimit],
    }).success,
  );
});

test("ref 分支界逐字一致：两侧对 bytes/dimension 界给出同结论", () => {
  const ok = { ref: VALID_REF, mimeType: "image/png", bytes: 10 };
  assert.ok(toolMediaRefImageSchema.safeParse(ok).success);
  assert.ok(
    nodeReplImageToolResultDisplayPayloadSchema.safeParse({
      kind: "node_repl_images",
      images: [ok],
    }).success,
  );
  const badBytes = { ref: VALID_REF, mimeType: "image/png", bytes: -1 };
  assert.ok(!toolMediaRefImageSchema.safeParse(badBytes).success);
  assert.ok(
    !nodeReplImageToolResultDisplayPayloadSchema.safeParse({
      kind: "node_repl_images",
      images: [badBytes],
    }).success,
  );
});

test("整块 display 过 wire union：shared toolCallDisplaySchema 与 contracts toolResultDisplayPayloadSchema 同结论", () => {
  const displays = [
    { kind: "node_repl_images", images: [{ ref: VALID_REF, mimeType: "image/png", bytes: 10 }] },
    { kind: "node_repl_images", images: [{ base64: PNG_B64, mimeType: "image/png" }] },
    { kind: "node_repl_images", app: { appKey: "darwin:com.apple.Safari" } },
    {
      kind: "node_repl_images",
      images: [{ base64: PNG_B64, mimeType: "image/png" }],
      truncated: true,
      source: "browser_turn_end",
    },
    // 负例：ref 形态非法 → 两侧都拒整块 display。
    {
      kind: "node_repl_images",
      images: [{ ref: "/etc/passwd", mimeType: "image/png", bytes: 10 }],
    },
    // 负例：未知 kind 级字段 → strict 拒。
    {
      kind: "node_repl_images",
      images: [{ base64: PNG_B64, mimeType: "image/png" }],
      unknownField: 1,
    },
  ];
  const expected = [true, true, true, true, false, false];
  displays.forEach((display, i) => {
    const shared = toolCallDisplaySchema.safeParse(display).success;
    const contracts = toolResultDisplayPayloadSchema.safeParse(display).success;
    assert.equal(shared, expected[i], `shared 第 ${i} 条期望 ${expected[i]} 实得 ${shared}`);
    assert.equal(
      contracts,
      expected[i],
      `contracts 第 ${i} 条期望 ${expected[i]} 实得 ${contracts}`,
    );
  });
});

test("样本表有察觉力：ref 与 inline 的关键界各自至少一条正例一条负例", () => {
  // 证明镜像守护不是「两侧都恒真」的空测试：对每个关键界，样本表里都存在一条应接受、
  // 一条应拒绝的用例。若某一侧把界改宽/改窄，上面的 mismatch 断言会立刻红。
  const hasBoundary = (predicate) => {
    const matching = IMAGE_SAMPLES.filter(predicate);
    return matching.some((s) => s.accept) && matching.some((s) => !s.accept);
  };
  assert.ok(
    hasBoundary((s) => "base64" in s.image && !("ref" in s.image)),
    "inline base64 界有正负例",
  );
  assert.ok(
    hasBoundary((s) => "ref" in s.image && "bytes" in s.image),
    "ref bytes 界有正负例",
  );
  assert.ok(
    hasBoundary((s) => "ref" in s.image && typeof s.image.ref === "string"),
    "ref 形态门有正负例",
  );
});
