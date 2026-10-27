// U11 producer 半程验收测试
// （spec: apps/acode-cli/specs/tool-media-attachment-ref.md §6 R7–R10 / 验收 U11-P1…P9）。
//
// 覆盖：生产门矩阵（R10.1/R10.2）、持久化恰好一次（R7.3）、ref 形态发布前的形态门（R8.3）、
// 写失败回落 inline 且**绝不发布悬空 ref**（R9.1/R9.3）、abort 重抛（R9.2）、上限不变（R7.4）、
// 以及**真实 NodeToolArtifactStore** 的 data URL 往返（R8.1，含裸二进制写入的负证据）。
//
// 无 jsdom；端口用注入 fake（artifactStore），持久化用真实 NodeToolArtifactStore 做往返。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { shouldEmitToolMediaRefs, extensionForImageMimeType } =
  await import("../packages/core/src/tool/executor/tool-media-limits.ts");
const {
  persistNodeReplImageRefs,
  persistNodeReplImageRefsForOutput,
  noteNodeReplImageRefs,
  readNodeReplImageRefs,
} = await import("../packages/core/src/tool/handlers/node-repl-media.ts");
const { createNodeReplDisplay } =
  await import("../packages/core/src/tool/executor/node-repl-display.ts");
const { createToolResultDisplay } =
  await import("../packages/core/src/tool/executor/result-display.ts");
const { NodeToolArtifactStore } = await import("../packages/adapters/src/storage/index.ts");
// shared（zod v4）与 contracts（zod v3）两份 schema：display 必须同时过两侧（R10.5/P8）。
// CLI 测试目录不解析裸 @acode/shared（pnpm 未提升到 apps/acode-cli），走相对路径（三层到仓库根）。
const { toolMediaImageSchema, toolCallDisplaySchema, inspectToolMediaRef, TOOL_MEDIA_REF_SCHEME } =
  await import("../../../packages/shared/src/acode-protocol-v4/index.ts");
const { toolResultDisplayPayloadSchema } =
  await import("../packages/contracts/src/tools/tool-result-metadata.ts");

const SESSION = "sess-u11-producer";
const TURN = "turn-1";
const CALL = "call-1";

/** 一张 1x1 PNG（真实字节，16B）——够小到必然过 200 KiB 上限。 */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const PNG_B64 = PNG.toString("base64");

function baseContext(overrides = {}) {
  return {
    toolCallId: CALL,
    traceId: "trace-1",
    sessionId: SESSION,
    turnId: TURN,
    abortSignal: new AbortController().signal,
    workingDirectory: process.cwd(),
    workspaceRoot: process.cwd(),
    ...overrides,
  };
}

/**
 * 计数 fake artifact store：产 `acode-artifact://<encodeURIComponent(session)>/<id>` 形态的 uri
 * （与真实 store 逐字同形，于是 authority 绑定断言有意义）。可注入写失败/abort。
 */
function makeFakeStore({ fail = false, failOnIndex = -1 } = {}) {
  const writes = [];
  let seq = 0;
  return {
    writes,
    async writeToolResultArtifact(request, options) {
      const index = writes.length;
      writes.push({ request, options });
      if (options?.signal?.aborted) {
        throw options.signal.reason instanceof Error
          ? options.signal.reason
          : new Error("cancelled");
      }
      if (fail || index === failOnIndex) {
        throw new Error("disk full");
      }
      seq += 1;
      return {
        id: `tool-result-${seq}`,
        uri: `acode-artifact://${encodeURIComponent(request.sessionId)}/tool-result-${seq}`,
        bytes: Buffer.byteLength(request.content, "utf8"),
        contentType: request.contentType ?? "text/plain",
        createdAt: new Date(),
      };
    },
  };
}

// ── R10.1 / R10.2：生产门矩阵 ──

test("(R10.1) 门默认关闭：缺席 / false 都不产 ref", () => {
  assert.equal(
    shouldEmitToolMediaRefs({
      clientMode: "desktop-continuous",
      hasArtifactStore: true,
    }),
    false,
    "enabled 缺席 = 关闭",
  );
  assert.equal(
    shouldEmitToolMediaRefs({
      enabled: false,
      clientMode: "desktop-continuous",
      hasArtifactStore: true,
    }),
    false,
    "enabled=false = 关闭",
  );
});

test("(R10.1) 门开 + desktop-continuous + store 在场 = 产 ref", () => {
  assert.equal(
    shouldEmitToolMediaRefs({
      enabled: true,
      clientMode: "desktop-continuous",
      hasArtifactStore: true,
    }),
    true,
  );
});

test("(R10.2) 门开但 clientMode≠desktop-continuous（web-remote-replayable / 缺席）= 不产 ref", () => {
  assert.equal(
    shouldEmitToolMediaRefs({
      enabled: true,
      clientMode: "web-remote-replayable",
      hasArtifactStore: true,
    }),
    false,
    "偏斜面 fail-safe：web-remote-replayable 一律 inline",
  );
  assert.equal(
    shouldEmitToolMediaRefs({ enabled: true, hasArtifactStore: true }),
    false,
    "clientMode 缺席（TUI/headless）= 不产 ref",
  );
});

test("(R9.4) 门开但 store 缺席 = 不产 ref（无落点即不发布悬空引用）", () => {
  assert.equal(
    shouldEmitToolMediaRefs({
      enabled: true,
      clientMode: "desktop-continuous",
      hasArtifactStore: false,
    }),
    false,
  );
});

// ── R7.3 / P1：持久化恰好一次 + ref 形态 ──

test("(R7.3/P1) 两张图各持久化一次，产出两条 index 对齐的 ref", async () => {
  const store = makeFakeStore();
  const images = [
    { base64: PNG_B64, mimeType: "image/png" },
    { base64: PNG_B64, mimeType: "image/jpeg" },
  ];
  const refs = await persistNodeReplImageRefs({
    artifactStore: store,
    context: baseContext(),
    images,
  });
  assert.equal(store.writes.length, 2, "每张图恰好写一次");
  assert.equal(refs.length, 2);
  assert.deepEqual(
    refs.map((r) => r.index),
    [0, 1],
    "index 与 images 下标一一对应",
  );
  for (const r of refs) {
    assert.equal(inspectToolMediaRef(r.ref), null, "发布的 ref 过形态门（R8.3）");
    assert.equal(r.bytes, PNG.byteLength, "bytes 是解码后字节数（R8.4）");
  }
});

test("(R8.2/P1) ref 的 authority 逐字等于 encodeURIComponent(sessionId)", async () => {
  const store = makeFakeStore();
  const refs = await persistNodeReplImageRefs({
    artifactStore: store,
    context: baseContext(),
    images: [{ base64: PNG_B64, mimeType: "image/png" }],
  });
  const ref = refs[0].ref;
  const authority = ref.slice(
    TOOL_MEDIA_REF_SCHEME.length,
    ref.indexOf("/", TOOL_MEDIA_REF_SCHEME.length),
  );
  assert.equal(authority, encodeURIComponent(SESSION));
});

test("(R8.1) 写入形态是 data URL 文本，不是裸二进制", async () => {
  const store = makeFakeStore();
  await persistNodeReplImageRefs({
    artifactStore: store,
    context: baseContext(),
    images: [{ base64: PNG_B64, mimeType: "image/png" }],
  });
  const req = store.writes[0].request;
  assert.equal(req.contentType, "text/plain", "text/plain → store 落 .txt → 读回是 utf8 文本");
  assert.ok(
    req.content.startsWith("data:image/png;base64,"),
    "正文是 data URL（decodePromptAttachmentDataUrl 的前提）",
  );
  assert.equal(req.toolName, "js");
  assert.equal(req.retention, "session");
});

// ── R7.4 / P6：上限不变 ──

test("(R7.4/P6) 超 200 KiB 的图不持久化（自然回落 inline，上限不提高）", async () => {
  const store = makeFakeStore();
  const huge = "A".repeat(200 * 1024 + 1); // base64 字符数超上限
  const refs = await persistNodeReplImageRefs({
    artifactStore: store,
    context: baseContext(),
    images: [{ base64: huge, mimeType: "image/png" }],
  });
  assert.equal(store.writes.length, 0, "超限图不写盘");
  assert.equal(refs.length, 0);
});

test("(R7.4/P6) display 仍 ≤2 张：3 张图 → 2 张 + truncated", () => {
  const output = {
    images: [
      { base64: PNG_B64, mimeType: "image/png" },
      { base64: PNG_B64, mimeType: "image/png" },
      { base64: PNG_B64, mimeType: "image/png" },
    ],
  };
  const display = createNodeReplDisplay("js", output);
  assert.equal(display.kind, "node_repl_images");
  assert.equal(display.images.length, 2, "仍限 2 张");
  assert.equal(display.truncated, true);
});

// ── R9.1 / R9.3 / P2：写失败回落 inline，绝不发布悬空 ref ──

test("(R9.1/P2) 单张写失败 → 该张不进侧信道（display 回落 inline），其余照发", async () => {
  const store = makeFakeStore({ failOnIndex: 1 });
  const images = [
    { base64: PNG_B64, mimeType: "image/png" },
    { base64: PNG_B64, mimeType: "image/png" },
  ];
  const refs = await persistNodeReplImageRefs({
    artifactStore: store,
    context: baseContext(),
    images,
  });
  assert.equal(refs.length, 1, "写失败的那张不产 ref");
  assert.equal(refs[0].index, 0, "只有 index 0 成功");
});

test("(R9.3/P2) 写失败的图在 display 里是 inline base64，不是悬空 ref", async () => {
  const store = makeFakeStore({ failOnIndex: 0 });
  const images = [{ base64: PNG_B64, mimeType: "image/png" }];
  const output = { images };
  const refs = await persistNodeReplImageRefs({
    artifactStore: store,
    context: baseContext(),
    images,
  });
  noteNodeReplImageRefs(output, refs); // refs 为空 → 不写侧信道
  const display = createNodeReplDisplay("js", output);
  assert.equal(display.images.length, 1);
  assert.ok("base64" in display.images[0], "回落 inline");
  assert.ok(!("ref" in display.images[0]), "绝不发布悬空 ref");
});

test("(R9.1) 全部写失败 → 全 inline，工具输出不含 ref", async () => {
  const store = makeFakeStore({ fail: true });
  const images = [
    { base64: PNG_B64, mimeType: "image/png" },
    { base64: PNG_B64, mimeType: "image/png" },
  ];
  const refs = await persistNodeReplImageRefs({
    artifactStore: store,
    context: baseContext(),
    images,
  });
  assert.equal(refs.length, 0);
});

// ── R9.2 / P7：abort 重抛 ──

test("(R9.2/P7) abortSignal 已取消 → 上抛取消，不吞成降级", async () => {
  const ac = new AbortController();
  ac.abort(new Error("user cancelled"));
  const store = makeFakeStore();
  await assert.rejects(
    () =>
      persistNodeReplImageRefs({
        artifactStore: store,
        context: baseContext({ abortSignal: ac.signal }),
        images: [{ base64: PNG_B64, mimeType: "image/png" }],
      }),
    /user cancelled/,
    "取消必须上抛，不能被降级吞掉",
  );
});

// ── R7.2：ref 不进 JsOutput，只走 WeakMap 侧信道 ──

test("(R7.2) ref 走 WeakMap 侧信道：output 对象本身不含 ref 字段", async () => {
  const store = makeFakeStore();
  const images = [{ base64: PNG_B64, mimeType: "image/png" }];
  const output = { logs: "", images };
  await persistNodeReplImageRefsForOutput({
    enabled: true,
    context: baseContext({ clientMode: "desktop-continuous", artifactStore: store }),
    images,
    output,
  });
  // JsOutput 逐字不变（模型可见面不加字段）。
  assert.deepEqual(Object.keys(output).sort(), ["images", "logs"]);
  const refs = readNodeReplImageRefs(output);
  assert.equal(refs?.length, 1, "ref 在侧信道里");
});

test("(R7.2) 别的输出对象（非本模块产出）取不到 ref —— WeakMap 键身份隔离", () => {
  const impostor = { logs: "", images: [{ base64: PNG_B64, mimeType: "image/png" }] };
  assert.equal(readNodeReplImageRefs(impostor), undefined);
  assert.equal(readNodeReplImageRefs(null), undefined);
  assert.equal(readNodeReplImageRefs("nope"), undefined);
});

test("(R10.2) persistNodeReplImageRefsForOutput：门开但 clientMode 非 desktop → 不写盘", async () => {
  const store = makeFakeStore();
  const images = [{ base64: PNG_B64, mimeType: "image/png" }];
  const output = { logs: "", images };
  await persistNodeReplImageRefsForOutput({
    enabled: true,
    context: baseContext({ clientMode: "web-remote-replayable", artifactStore: store }),
    images,
    output,
  });
  assert.equal(store.writes.length, 0);
  assert.equal(readNodeReplImageRefs(output), undefined);
});

test("(R10.1) persistNodeReplImageRefsForOutput：门关（enabled=false）→ 不写盘", async () => {
  const store = makeFakeStore();
  const images = [{ base64: PNG_B64, mimeType: "image/png" }];
  const output = { logs: "", images };
  await persistNodeReplImageRefsForOutput({
    enabled: false,
    context: baseContext({ clientMode: "desktop-continuous", artifactStore: store }),
    images,
    output,
  });
  assert.equal(store.writes.length, 0);
});

// ── display 发 ref 形态 + 双 schema 校验（P8）──

test("(P8) 门开时 display 发 ref 形态，同时过 shared(zod4) 与 contracts(zod3) 两份 schema", async () => {
  const store = makeFakeStore();
  const images = [{ base64: PNG_B64, mimeType: "image/png" }];
  const output = { logs: "", images };
  await persistNodeReplImageRefsForOutput({
    enabled: true,
    context: baseContext({ clientMode: "desktop-continuous", artifactStore: store }),
    images,
    output,
  });
  const display = createNodeReplDisplay("js", output);
  assert.equal(display.kind, "node_repl_images");
  assert.equal(display.images.length, 1);
  const img = display.images[0];
  assert.ok("ref" in img && !("base64" in img), "ref 形态");
  assert.equal(img.bytes, PNG.byteLength);

  // 单张图片过 shared 的 union。
  assert.ok(toolMediaImageSchema.safeParse(img).success, "shared toolMediaImageSchema 接受");
  // 整块 display 过 contracts 镜像 union。
  const contractsOk = toolResultDisplayPayloadSchema.safeParse(display);
  assert.ok(
    contractsOk.success,
    `contracts 镜像接受: ${JSON.stringify(contractsOk.error?.issues?.slice(0, 2))}`,
  );
  // 整块 display 也过 shared 的 toolCallDisplaySchema（wire 面）。
  const sharedOk = toolCallDisplaySchema.safeParse(display);
  assert.ok(
    sharedOk.success,
    `shared toolCallDisplaySchema 接受: ${JSON.stringify(sharedOk.error?.issues?.slice(0, 2))}`,
  );
});

test("(P8) 门关时 display 全 inline，两份 schema 同样接受（向后兼容，A4）", () => {
  const output = { logs: "", images: [{ base64: PNG_B64, mimeType: "image/png" }] };
  const display = createNodeReplDisplay("js", output);
  assert.equal(display.images.length, 1);
  assert.ok("base64" in display.images[0], "inline 形态");
  assert.ok(toolMediaImageSchema.safeParse(display.images[0]).success);
  assert.ok(toolResultDisplayPayloadSchema.safeParse(display).success);
  assert.ok(toolCallDisplaySchema.safeParse(display).success);
});

test("(R7.6) content 派生的图不产 ref（下标只对 output.images 有意义）", () => {
  // 侧信道里 index=0 的 ref，但 images 为空、content 里有一张图 → content 图 index 落在
  // outputImages.length 之外，不命中侧信道 → inline。
  const output = {
    logs: "",
    images: [],
    content: [{ type: "image", data: PNG_B64, mimeType: "image/png" }],
  };
  noteNodeReplImageRefs(output, [
    { index: 0, ref: "acode-artifact://x/y", mimeType: "image/png", bytes: 16 },
  ]);
  const display = createNodeReplDisplay("js", output);
  assert.equal(display.images.length, 1);
  assert.ok("base64" in display.images[0], "content 派生图保持 inline");
});

test("(纯动作 cell) 无图但有 app 身份 → 仍产 display（images 缺席，不回归）", () => {
  const output = {
    logs: "",
    _meta: { "acode/nodeReplCuaApp": { appKey: "darwin:com.apple.Safari" } },
  };
  const display = createNodeReplDisplay("js", output);
  assert.equal(display.kind, "node_repl_images");
  assert.equal(display.images, undefined);
  assert.ok(display.app);
});

// ── R8.1 / P9：真实 NodeToolArtifactStore 往返 ──

test("(R8.1/P9) 真实 store：data URL 写入 → readToolResultArtifact → decodePromptAttachmentDataUrl 逐字还原", async () => {
  const root = await mkdtemp(join(tmpdir(), "u11-real-"));
  try {
    const store = new NodeToolArtifactStore({
      rootDir: join(root, "artifacts"),
      imageCacheRootDir: join(root, "img"),
      videoCacheRootDir: join(root, "vid"),
    });
    const refs = await persistNodeReplImageRefs({
      artifactStore: store,
      context: baseContext(),
      images: [{ base64: PNG_B64, mimeType: "image/png" }],
    });
    assert.equal(refs.length, 1);
    const read = await store.readToolResultArtifact({ uri: refs[0].ref });
    assert.equal(read.contentType, "text/plain", ".txt → utf8 读回，正文是 data URL");
    // decodePromptAttachmentDataUrl 的核心判据（bootstrap/app/create-app.ts:149-180 逐字副本）：
    const comma = read.content.indexOf(",");
    const header = read.content.slice("data:".length, comma).split(";");
    assert.equal(header.at(-1)?.trim().toLowerCase(), "base64");
    const payload = read.content.slice(comma + 1);
    assert.ok(/^[A-Za-z0-9+/]*={0,2}$/u.test(payload) && payload.length % 4 === 0);
    const decoded = Buffer.from(payload, "base64");
    assert.equal(Buffer.compare(decoded, PNG), 0, "字节逐字还原");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("(R8.1/P9) 负证据：裸二进制写入 → readToolResultArtifact 读回无 data: 头 → 解码必失败", async () => {
  const root = await mkdtemp(join(tmpdir(), "u11-neg-"));
  try {
    const store = new NodeToolArtifactStore({
      rootDir: join(root, "artifacts"),
      imageCacheRootDir: join(root, "img"),
      videoCacheRootDir: join(root, "vid"),
    });
    // 若误用 writeToolResultBinaryArtifact（persistBrowserScreenshotPaths 的写法）：
    const bin = await store.writeToolResultBinaryArtifact({
      sessionId: SESSION,
      turnId: TURN,
      toolCallId: CALL,
      toolName: "js",
      content: PNG,
      contentType: "image/png",
      extension: extensionForImageMimeType("image/png"),
      retention: "session",
    });
    const read = await store.readToolResultArtifact({ uri: bin.uri });
    assert.equal(read.contentType, "image/png", ".png → 非 text → base64 编码返回");
    assert.ok(
      !read.content.startsWith("data:"),
      "裸二进制读回**没有** data: 头 → decodePromptAttachmentDataUrl 会抛 previewArtifactInvalid",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── createToolResultDisplay 端到端（js 分支透传）──

test("(端到端) createToolResultDisplay('js', output) 透传侧信道 ref 形态", async () => {
  const store = makeFakeStore();
  const images = [{ base64: PNG_B64, mimeType: "image/png" }];
  const output = { logs: "", images };
  await persistNodeReplImageRefsForOutput({
    enabled: true,
    context: baseContext({ clientMode: "desktop-continuous", artifactStore: store }),
    images,
    output,
  });
  const display = createToolResultDisplay("js", output, {});
  assert.equal(display?.kind, "node_repl_images");
  assert.ok("ref" in display.images[0]);
});

// ── 端到端：producer 发出的 ref 必须满足 gateway 授权链第 ③ 步（R7 ↔ 消费半程 R3）──

test("(端到端授权) producer 发出的 ref 被 resolveAuthorizedToolMedia 命中，且 mime/bytes 取行上的值", async () => {
  const { resolveAuthorizedToolMedia } =
    await import("../packages/bootstrap/src/acode-protocol-v4/tool-media-authorization.ts");
  const store = makeFakeStore();
  const images = [{ base64: PNG_B64, mimeType: "image/png" }];
  const output = { logs: "", images };
  await persistNodeReplImageRefsForOutput({
    enabled: true,
    context: baseContext({ clientMode: "desktop-continuous", artifactStore: store }),
    images,
    output,
  });
  const display = createToolResultDisplay("js", output, {});

  // 模拟 gateway 投影：display 落在一条权威 toolCall row 上。
  const rows = [
    {
      rowId: 1,
      entityId: "tc-1",
      kind: "toolCall",
      toolCallId: CALL,
      toolName: "js",
      status: "success",
      display,
    },
  ];
  const emittedRef = display.images[0].ref;
  const authorized = resolveAuthorizedToolMedia({ rows, sessionId: SESSION, ref: emittedRef });
  assert.ok(authorized, "本 session 权威 row 上的 ref 必须被授权（第 ③ 步逐字命中）");
  assert.equal(authorized.mime, "image/png", "mime 取行上的值");
  assert.equal(authorized.bytes, PNG.byteLength, "bytes 取行上的值");

  // 跨 session 的同一 ref 必须被拒（authority 绑定 sessionId）。
  assert.equal(
    resolveAuthorizedToolMedia({ rows, sessionId: "sess-intruder", ref: emittedRef }),
    null,
    "跨 session 拒绝",
  );
  // ref 只在文本里出现不构成授权。
  assert.equal(
    resolveAuthorizedToolMedia({
      rows: [{ ...rows[0], display: undefined, output: { text: emittedRef } }],
      sessionId: SESSION,
      ref: emittedRef,
    }),
    null,
    "文本出现不授权",
  );
});
