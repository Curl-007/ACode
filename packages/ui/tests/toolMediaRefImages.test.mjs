// U11 ref 形态图片抽取测试（spec: packages/ui/specs/tool-media-on-demand.md）。
// 纯函数、无 jsdom：覆盖实时/终态/冷恢复三种 display 落点、形态非法降级、去重与数量上限，
// 以及与 inline 抽取路径的不重叠（同一张图不被读两次）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractToolMediaRefImages } from "../src/lib/toolMediaRefImages.js";

const SESSION = "sess-owner";
const REF = `acode-artifact://${encodeURIComponent(SESSION)}/art-001`;
const REF2 = `acode-artifact://${encodeURIComponent(SESSION)}/art-002`;

function refImage(ref = REF, overrides = {}) {
  return { ref, mimeType: "image/png", bytes: 1234, ...overrides };
}

function display(images) {
  return { kind: "node_repl_images", images };
}

/** 最小 TaskChatToolCall 形状（抽取只读 output/raw）。 */
function toolCall({ output, raw } = {}) {
  return {
    toolId: "tc-1",
    kind: "mcp__node_repl__js",
    input: {},
    status: "completed",
    ...(output === undefined ? {} : { output }),
    ...(raw === undefined ? {} : { raw }),
  };
}

test("U11-A2: 从 output.display 抽出 ref 形态图片", () => {
  const images = extractToolMediaRefImages(
    toolCall({ output: { display: display([refImage()]) } }),
  );
  assert.equal(images.length, 1);
  assert.equal(images[0].ref, REF);
  assert.equal(images[0].mimeType, "image/png");
  assert.equal(images[0].bytes, 1234);
});

test("U11-A2: 实时 tool.updated 把 display 放在 raw.result 内也能抽出", () => {
  const images = extractToolMediaRefImages(toolCall({ raw: { result: display([refImage()]) } }));
  assert.equal(images.length, 1);
  assert.equal(images[0].ref, REF);
});

test("U11-A4: 终态 snapshot 把 display 当作 raw（v4 适配器落点）也能抽出", () => {
  const images = extractToolMediaRefImages(toolCall({ raw: { display: display([refImage()]) } }));
  assert.equal(images.length, 1);
  assert.equal(images[0].ref, REF);
});

test("U11-A2: 携带尺寸/校验元数据时原样保留，缺席时不补默认值", () => {
  const withMeta = extractToolMediaRefImages(
    toolCall({
      output: {
        display: display([refImage(REF, { width: 640, height: 480, sha256: "a".repeat(64) })]),
      },
    }),
  );
  assert.equal(withMeta[0].width, 640);
  assert.equal(withMeta[0].height, 480);
  assert.equal(withMeta[0].sha256, "a".repeat(64));

  const withoutMeta = extractToolMediaRefImages(
    toolCall({ output: { display: display([refImage()]) } }),
  );
  assert.equal(withoutMeta[0].width, undefined);
  assert.equal("width" in withoutMeta[0], false, "缺席字段不应被补成 undefined 键");
});

test("U11-A3: 形态非法的 ref 被丢弃（降级为不显示，不崩溃）", () => {
  const bad = [
    refImage("file:///etc/passwd"),
    refImage(`acode-artifact://${encodeURIComponent(SESSION)}/../../x`),
    refImage("acode-artifact://sess/art:stream"),
    { ref: REF, mimeType: "application/pdf", bytes: 10 }, // 非 image mime
    { ref: REF, mimeType: "image/png", bytes: 0 }, // bytes 非正
    { ref: REF, mimeType: "image/png" }, // 缺 bytes
    { mimeType: "image/png", bytes: 10 }, // 缺 ref
  ];
  const images = extractToolMediaRefImages(toolCall({ output: { display: display(bad) } }));
  assert.deepEqual(images, [], "所有非法候选都应被丢弃");
});

test("U11-A1: 按 ref 去重，保持出现顺序", () => {
  const images = extractToolMediaRefImages(
    toolCall({ output: { display: display([refImage(REF2), refImage(REF), refImage(REF2)]) } }),
  );
  assert.equal(images.length, 2);
  assert.equal(images[0].ref, REF2);
  assert.equal(images[1].ref, REF);
});

test("U11-A1: 最多抽出 2 张（与生产上限一致，不提高）", () => {
  const many = [
    refImage("acode-artifact://sess-owner/a"),
    refImage("acode-artifact://sess-owner/b"),
    refImage("acode-artifact://sess-owner/c"),
  ];
  assert.equal(
    extractToolMediaRefImages(toolCall({ output: { display: display(many) } })).length,
    2,
  );
  // 显式 maxImages 可收紧（测试可注入），默认仍是 2。
  assert.equal(
    extractToolMediaRefImages(toolCall({ output: { display: display(many) } }), 1).length,
    1,
  );
});

test("U11-A4: inline 形态不被 ref 抽取路径收走（两条路径不重叠）", () => {
  const images = extractToolMediaRefImages(
    toolCall({ output: { display: display([{ base64: "aGVsbG8=", mimeType: "image/png" }]) } }),
  );
  assert.deepEqual(images, [], "inline 图片没有 ref，不应出现在 ref 抽取结果里");
});

test("U11-A2: inline 与 ref 混合时只抽 ref 那部分", () => {
  const images = extractToolMediaRefImages(
    toolCall({
      output: { display: display([{ base64: "aGVsbG8=", mimeType: "image/png" }, refImage()]) },
    }),
  );
  assert.equal(images.length, 1);
  assert.equal(images[0].ref, REF);
});

test("U11-A1: 纯动作 cell（无 images / 仅 app）抽出空数组", () => {
  assert.deepEqual(
    extractToolMediaRefImages(
      toolCall({ output: { display: { kind: "node_repl_images", app: { appKey: "darwin:x" } } } }),
    ),
    [],
  );
  assert.deepEqual(extractToolMediaRefImages(toolCall({})), []);
});

test("U11-A1: 非 node_repl_images 的 display 不产生 ref 图片", () => {
  const images = extractToolMediaRefImages(
    toolCall({
      output: {
        display: { kind: "task_output", retrievalStatus: "success", images: [refImage()] },
      },
    }),
  );
  assert.deepEqual(images, [], "只认 node_repl_images 这一族工具媒体 display");
});

test("U11-A5: 循环引用不死循环（visited 去环）", () => {
  const cyclic = { kind: "node_repl_images", images: [refImage()] };
  cyclic.self = cyclic;
  const images = extractToolMediaRefImages(toolCall({ output: { display: cyclic } }));
  assert.equal(images.length, 1);
});

test("U11-A3: null/数组 display 不被误当作记录（isRecord 守卫回归）", () => {
  // 回归：isRecord 曾写成 `typeof value !== null`（恒真），会让 typeof null === "object" 误判为记录。
  assert.deepEqual(extractToolMediaRefImages(toolCall({ output: null })), []);
  assert.deepEqual(extractToolMediaRefImages(toolCall({ output: { display: null } })), []);
  assert.deepEqual(extractToolMediaRefImages(toolCall({ raw: [null, undefined] })), []);
  assert.deepEqual(extractToolMediaRefImages(toolCall({ output: { display: [refImage()] } })), []);
});
