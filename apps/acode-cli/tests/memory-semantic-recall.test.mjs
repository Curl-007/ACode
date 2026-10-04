import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

/**
 * K1 验收测试：记忆语义召回三阶段管线 Phase A + 会话级召回通道 + R7 两债清偿 + R8 度量账本。
 * 规格 apps/acode-cli/specs/memory-semantic-recall.md（机制参照 jcode MIT 的
 * memory.rs / embedding_backend.rs / memory_rerank.rs，自撰实现）。
 *
 * 覆盖（spec 验收场景 1-16 的 Phase A 部分）：
 *   1-3   分词与 BM25（中文 bigram、description 加权、200 文档性能钉子）
 *   4-7   融合与隔离（RRF 手算、sidecar 空间隔离/损坏/backfill 上限——纯逻辑，
 *         pipeline 本轮不接 sidecar，属 Phase B 消费面）
 *   8     降级链（embedding 抛错 → phaseMask A + degradedReasons + warn 一次）
 *   9     重排接口位（缺省 undefined = Phase C off，零模型调用）
 *   10-13 会话级通道（首轮跳过、query 纯文本投影、reference 形态、
 *         context section 快照字节不变、四层去重全可达 + 层 4 微改写剔除）
 *   14    时钟债（墙钟回拨不受影响、capturedAtMs > now 拒绝）
 *   15    协议不变（J3-2 全部场景由 tests/memory-injection-fail-closed.test.mjs 重跑
 *         保证；此处钉住 Extraction 通道行为不变的源码事实）
 *   16    度量（分类计数落 JSONL、content/description 全文不落账本）
 *
 * 内存 FileSystemPort 桩件复用 J3-2 测试的形态（精确控制文件集合与 mtime）；
 * 端到端通道用例用真实 createNodeFileSystemAdapter + tmpdir（度量账本走真实磁盘追加）。
 */

const repoRoot = new URL("../../../", import.meta.url);
const readSource = (path) => readFile(new URL(path, repoRoot), "utf8");
const CORE = "apps/acode-cli/packages/core/src";

const {
  createMemoryRecallInjector,
  resolveMemoryIdentityKey,
} = await import("../packages/core/src/memory/recall/pending.ts");
const {
  RETRIEVAL_CONSTANTS,
  buildBm25Index,
  buildRetrievalDocumentTokens,
  createMemoryRetrievalPipeline,
  createRecallMetricsLedger,
  fuseWithRrf,
  isSidecarModelSpaceCurrent,
  loadRecallSidecarIndex,
  parseRecallSidecarIndex,
  computeSidecarCoverage,
  selectSidecarBackfill,
  rankByBm25,
  recallQueryHash,
  tokenizeForRetrieval,
} = await import("../packages/core/src/memory/recall/retrieval/index.ts");
const { buildMemorySection } = await import("../packages/core/src/context/sections/memory.ts");
const {
  buildSemanticMemoryRecallReminderBody,
  isFirstConversationTurn,
  latestRealUserPlainTextQuery,
} = await import("../packages/core/src/runtime/helpers/memory-semantic-recall.ts");
const { createNodeFileSystemAdapter } = await import("../packages/adapters/src/fs/index.ts");

// ── 夹具（与 J3-2 测试同款内存 FileSystemPort 桩件） ─────────────────────

const ROOT = "/store/memories/projects/demo-0123456789abcdef/memory";
const IDENTITY_KEY = "remote:ssh/host:/repos/demo";
const BASE_MTIME = 1_760_000_000_000;

const pathOf = (name) => `${ROOT}/${name}`;

function memoryMarkdown({ body = "One fact.", description, name, tags, type = "project" }) {
  const frontmatter = [
    "---",
    `name: ${name}`,
    ...(description ? [`description: ${description}`] : []),
    ...(tags ? [`tags: [${tags.join(", ")}]`] : []),
    "metadata:",
    `  type: ${type}`,
    "---",
    "",
  ].join("\n");
  return `${frontmatter}${body}\n`;
}

function createMemoryFs(initialFiles = {}) {
  const files = new Map();
  for (const [path, value] of Object.entries(initialFiles)) {
    files.set(path, { content: value.content, mtimeMs: value.mtimeMs ?? BASE_MTIME });
  }
  const listCalls = [];
  const port = {
    async listDirectory({ path }) {
      listCalls.push(path);
      const prefix = `${path}/`;
      const entries = [];
      const seenDirectories = new Set();
      for (const filePath of files.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash >= 0) {
          const directoryPath = prefix + rest.slice(0, slash);
          if (seenDirectories.has(directoryPath)) continue;
          seenDirectories.add(directoryPath);
          entries.push({ kind: "directory", path: directoryPath });
          continue;
        }
        entries.push({ kind: "file", path: filePath });
      }
      return { entries, path };
    },
    async stat({ path }) {
      const entry = files.get(path);
      if (!entry) throw enoent(path);
      return {
        kind: "file",
        mtimeMs: entry.mtimeMs,
        path,
        sizeBytes: Buffer.byteLength(entry.content, "utf8"),
      };
    },
    async readTextFile({ path }) {
      const entry = files.get(path);
      if (!entry) throw enoent(path);
      return {
        bytesRead: Buffer.byteLength(entry.content, "utf8"),
        content: entry.content,
        encoding: "utf8",
        path,
        sizeBytes: Buffer.byteLength(entry.content, "utf8"),
        truncated: false,
      };
    },
  };
  return {
    listCalls,
    port,
    write(path, content, { mtimeMs } = {}) {
      const previous = files.get(path);
      files.set(path, { content, mtimeMs: mtimeMs ?? previous?.mtimeMs ?? BASE_MTIME });
    },
  };
}

function enoent(path) {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
    code: "ENOENT",
  });
}

function createClock(startMs = 0) {
  const clock = { t: startMs };
  return { advance: (ms) => (clock.t += ms), now: () => clock.t };
}

function createLoggerSpy() {
  const calls = [];
  return {
    calls,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message, context) => calls.push({ context, message }),
      error: () => {},
      child() {
        return this;
      },
    },
  };
}

function createPipelineFixture({ files, clock, logger, embedding, reranker } = {}) {
  const fs = createMemoryFs(files ?? defaultFiles());
  const time = clock ?? createClock();
  const spy = logger ?? createLoggerSpy();
  const injector = createMemoryRecallInjector({
    fileSystem: fs.port,
    logger: spy.logger,
    now: time.now,
  });
  const pipeline = createMemoryRetrievalPipeline({
    embedding,
    fileSystem: fs.port,
    injector,
    logger: spy.logger,
    now: time.now,
    reranker,
  });
  return { fs, injector, pipeline, scope: { identityKey: IDENTITY_KEY, memoryRoot: ROOT }, spy, time };
}

function defaultFiles() {
  return {
    [pathOf("alpha.md")]: {
      content: memoryMarkdown({ description: "Alpha fact", name: "alpha-slug" }),
    },
    [pathOf("beta.md")]: {
      content: memoryMarkdown({
        body: "主密钥分叉后旧凭据开始返回 401，轮换主密钥即可恢复。",
        description: "凭据 401 的根因是主密钥分叉",
        name: "beta-slug",
      }),
      mtimeMs: BASE_MTIME + 60_000,
    },
  };
}

// ── 1-3. 分词与 BM25（R2/R3） ──────────────────────────────────────────

test("S1 中文 bigram 分词：query「凭据 401」命中「主密钥分叉致凭据 401」且排位高于无关条目；拉丁词路径同样可达", async () => {
  // 分词器直钉：CJK 相邻码位 bigram + 单字符拉丁 token 丢弃 + 数字 token 保留。
  assert.deepEqual(tokenizeForRetrieval("凭据主密钥"), ["凭据", "据主", "主密", "密钥"]);
  assert.deepEqual(tokenizeForRetrieval("a 7 401"), ["401"]);
  assert.deepEqual(tokenizeForRetrieval("GPT-4 credential"), ["gpt-4", "credential"]);

  const { pipeline, scope } = createPipelineFixture({
    files: {
      [pathOf("unrelated.md")]: {
        content: memoryMarkdown({
          body: "The deployment checklist has three steps: build, upload, verify.",
          description: "Deployment checklist for the weekly release",
          name: "deploy-slug",
        }),
        mtimeMs: BASE_MTIME,
      },
      [pathOf("credential-401.md")]: {
        content: memoryMarkdown({
          body: "主密钥分叉后旧凭据开始返回 401，轮换主密钥即可恢复。",
          description: "凭据 401 的根因是主密钥分叉",
          name: "cred-slug",
        }),
        mtimeMs: BASE_MTIME + 1_000,
      },
    },
  });

  const retrieval = await pipeline.retrieve({ query: "凭据 401", scope });
  assert.equal(retrieval.status, "ok");
  assert.equal(retrieval.phaseMask, "A", "无 dense 后端时必须是纯 Phase A");
  assert.ok(retrieval.candidates.length > 0);
  assert.equal(
    retrieval.candidates[0].entry.filename,
    "credential-401.md",
    "中文 query 的 top1 必须是含「主密钥分叉致凭据 401」的记忆",
  );
  assert.ok(
    !retrieval.candidates.some((candidate) => candidate.entry.filename === "unrelated.md"),
    "无关条目不得进 top-K（BM25 零分不进排名）",
  );

  // 拉丁词路径：英文 query 经小写归一的拉丁 token 同样可达。
  const english = await pipeline.retrieve({ query: "deployment checklist", scope });
  assert.equal(english.status, "ok");
  assert.equal(english.candidates[0]?.entry.filename, "unrelated.md");
});

test("S2 description 加权 ×2：正文同等命中时 description 含 query 词者排前", async () => {
  const shared = "Two services share the same gateway configuration.";
  const { pipeline, scope } = createPipelineFixture({
    files: {
      [pathOf("without-desc-hit.md")]: {
        content: memoryMarkdown({
          body: `Gateway timeout retries. ${shared}`,
          description: "General retry policy",
          name: "without-slug",
        }),
        mtimeMs: BASE_MTIME,
      },
      [pathOf("with-desc-hit.md")]: {
        content: memoryMarkdown({
          body: `Backoff intervals documented. ${shared}`,
          description: "Gateway timeout 的退避间隔表",
          name: "with-slug",
        }),
        mtimeMs: BASE_MTIME,
      },
    },
  });

  const retrieval = await pipeline.retrieve({ query: "gateway timeout", scope });
  assert.equal(retrieval.status, "ok");
  assert.equal(
    retrieval.candidates[0].entry.filename,
    "with-desc-hit.md",
    "description 含 query 词（×2 计权）必须排在正文同等命中者之前",
  );
});

test("S3 200 文档 BM25 打分耗时 < 50ms（性能钉子；实测值见下方注释）", async () => {
  // 实测记录（开发机 Windows/Node 25，2026-10-04，200 文档 × ~990 token）：
  // rankByBm25 热身后 0.5-0.7ms、首次（冷 JIT）9.8ms；buildBm25Index 约 6ms。
  // spec R3 的口径是「200 文档 × 千级 token 的 BM25 打分 <5ms」（热身实测 0.5-0.7ms
  // 满足）；本断言覆盖更宽的「建索引 + 冷启动打分」全流程（实测 <16ms），断言上限 50ms，
  // 防的是把索引构建意外变成 O(n²) 之类的性能回归。
  const documents = [];
  for (let index = 0; index < 200; index++) {
    const tokens = [];
    for (let repeat = 0; repeat < 50; repeat++) {
      tokens.push(
        ...tokenizeForRetrieval(`模块${index} 第${repeat}行 配置项${index % 7} 凭据缓存 epoch-${repeat}`),
        ...tokenizeForRetrieval("the gateway retries the request when the upstream returns an error code"),
      );
    }
    documents.push({ id: `doc-${index}`, tokens });
  }

  const indexBuilt = buildBm25Index(documents);
  const startedAt = performance.now();
  const ranked = rankByBm25(indexBuilt, tokenizeForRetrieval("模块42 凭据缓存"));
  const durationMs = performance.now() - startedAt;
  assert.ok(ranked.length > 0, "前提坏了：query 竟然零命中");
  assert.ok(
    durationMs < 50,
    `200 文档 BM25 打分耗时 ${durationMs.toFixed(2)}ms 超过 50ms 性能预算`,
  );
});

// ── 4-7. 融合与隔离（R4；sidecar 是 Phase B 消费面，本轮纯逻辑 + 源码守卫） ──

test("S4a RRF 融合手算对照：score = Σ 1/(60 + rank)，部分交叉的 dense 序与 BM25 序融合正确", () => {
  const fused = fuseWithRrf([["a", "b", "c"], ["c", "a", "b"]], 5);
  // 手算：a = 1/61 + 1/62 ≈ 0.0325224；c = 1/63 + 1/61 ≈ 0.0324664；
  //       b = 1/62 + 1/63 ≈ 0.0320020 → 序 a > c > b。
  assert.deepEqual(
    fused.map((entry) => entry.id),
    ["a", "c", "b"],
  );
  const expected = {
    a: 1 / 61 + 1 / 62,
    b: 1 / 62 + 1 / 63,
    c: 1 / 63 + 1 / 61,
  };
  for (const entry of fused) {
    assert.ok(Math.abs(entry.fusedScore - expected[entry.id]) < 1e-12, `${entry.id} 融合分与手算不符`);
  }
});

test("S4b 无 dense 后端时 phaseMask=A 且候选序 = 纯 BM25 序（降级底线的字节一致）", async () => {
  const files = {};
  for (const name of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]) {
    files[pathOf(`${name}.md`)] = {
      content: memoryMarkdown({
        body: `${name} fact body about gateway retries and credential rotation.`,
        description: `${name} fact`,
        name: `${name}-slug`,
      }),
      mtimeMs: BASE_MTIME + name.charCodeAt(0),
    };
  }
  const { pipeline, scope } = createPipelineFixture({ files });
  const query = "gateway retries credential";
  const onlyA = await pipeline.retrieve({ query, scope });
  assert.equal(onlyA.phaseMask, "A");
  assert.deepEqual(onlyA.degradedReasons, [], "没有后端就没有降级，degradedReasons 必须为空");

  // 对照：直接用 BM25 纯函数算出的排名序与 pipeline 候选序一致。
  const documents = Object.entries(files).map(([path, value]) => ({
    id: path.slice(ROOT.length + 1),
    tokens: buildRetrievalDocumentTokens({
      content: value.content,
      description: value.content.match(/description: (.+)/)?.[1],
    }),
  }));
  const bm25Only = rankByBm25(buildBm25Index(documents), tokenizeForRetrieval(query));
  assert.deepEqual(
    onlyA.candidates.map((candidate) => candidate.entry.filename),
    bm25Only.slice(0, RETRIEVAL_CONSTANTS.RECALL_TOP_K).map((ranked) => ranked.id),
  );
});

test("S5 向量空间隔离：sidecar model ≠ 后端 modelId → 判过期；model 全等守卫在源码唯一处（绝不跨空间比较）", async () => {
  const foreign = parseRecallSidecarIndex(
    JSON.stringify({
      version: 1,
      model: "other-model-768",
      entries: [{ contentHash: "a".repeat(64), file: "a.md", vector: [0.1, 0.2] }],
    }),
  );
  assert.ok(foreign, "前提坏了：合法 sidecar 解析失败");
  assert.equal(
    isSidecarModelSpaceCurrent(foreign, RETRIEVAL_CONSTANTS.EMBEDDING_MODEL_ID),
    false,
    "model 字段与后端 modelId 不全等必须判过期",
  );

  const same = parseRecallSidecarIndex(
    JSON.stringify({
      version: 1,
      model: RETRIEVAL_CONSTANTS.EMBEDDING_MODEL_ID,
      entries: [{ contentHash: "a".repeat(64), file: "a.md", vector: [0.1] }],
    }),
  );
  assert.equal(isSidecarModelSpaceCurrent(same, RETRIEVAL_CONSTANTS.EMBEDDING_MODEL_ID), true);

  // load 全链路：空间不符 → model-space-changed（Phase B 关 + 重建标记），不是 invalid。
  // 键用 join 构造与实现同源（recallSidecarPath 走平台分隔符）。
  const fs = createMemoryFs({
    [join(ROOT, ".recall-index.json")]: {
      content: JSON.stringify({
        version: 1,
        model: "other-model-768",
        entries: [{ contentHash: "a".repeat(64), file: "a.md", vector: [0.1] }],
      }),
    },
  });
  assert.deepEqual(await loadRecallSidecarIndex(fs.port, ROOT, { modelId: "minilm-l6-v2-int8-384" }), {
    status: "model-space-changed",
  });

  // 源码断言（spec 场景 5）：embed 比较处有 model 全等守卫，且它是唯一判定点——
  // 任何想消费 sidecar 向量的代码都必须经 isSidecarModelSpaceCurrent，不得各自内联。
  const sidecar = await readSource(`${CORE}/memory/recall/retrieval/sidecar.ts`);
  assert.match(sidecar, /return index\.model === modelId;/u, "model 全等守卫缺失");
  assert.match(
    sidecar,
    /if \(!isSidecarModelSpaceCurrent\(index, options\.modelId\)\) return \{ status: "model-space-changed" \};/u,
    "load 消费向量的路径没有先过空间守卫",
  );
  // pipeline 本轮不接 sidecar（Phase B 消费面）——钉住 import 面不出现 sidecar 模块，
  // 注释里的 Phase B 登记说明不算接线。
  const pipelineSource = await readSource(`${CORE}/memory/recall/retrieval/pipeline.ts`);
  assert.doesNotMatch(pipelineSource, /from "\.\/sidecar\.js"/u, "Phase A pipeline 不得接入 sidecar");
});

test("S6 sidecar 损坏 / shape 不符 → invalid（删除重建 + warn 由 Phase B 写侧消费方负责）", () => {
  assert.equal(parseRecallSidecarIndex("{not json"), undefined);
  assert.equal(
    parseRecallSidecarIndex(JSON.stringify({ version: 99, model: "m", entries: [] })),
    undefined,
    "版本号不符 = shape 不符",
  );
  assert.equal(
    parseRecallSidecarIndex(
      JSON.stringify({
        version: 1,
        model: "m",
        entries: [{ contentHash: "x", file: "a.md", vector: ["0.1"] }],
      }),
    ),
    undefined,
    "vector 含非 number = shape 不符",
  );
  assert.equal(
    parseRecallSidecarIndex(
      JSON.stringify({
        version: 1,
        model: "m",
        entries: [{ contentHash: "x", file: "a.md", vector: [0.1] }],
      }),
      { expectedDim: 384 },
    ),
    undefined,
    "维度与后端 dim 不符 = shape 不符",
  );
});

test("S7 backfill 上限：21 条无向量 → 单次检索只补 20（missing 优先于 stale）", () => {
  const files = [];
  for (let index = 0; index < 21; index++) {
    files.push({ contentHash: `hash-${index}`, file: `doc-${index}.md` });
  }
  const index = {
    version: 1,
    model: RETRIEVAL_CONSTANTS.EMBEDDING_MODEL_ID,
    entries: [],
  };
  const coverage = computeSidecarCoverage(index, files);
  assert.equal(coverage.missing.length, 21);
  assert.equal(coverage.stale.length, 0);

  const backfill = selectSidecarBackfill(coverage);
  assert.equal(backfill.length, RETRIEVAL_CONSTANTS.SIDECAR_BACKFILL_LIMIT_PER_RETRIEVAL);
  assert.equal(backfill.length, 20, "21 条无向量只补 20，剩下一条下轮继续");
  assert.deepEqual(backfill, files.slice(0, 20).map((file) => file.file));

  // stale（改写文件）排在 missing 之后：先补新文件，再补改写文件。
  const mixed = computeSidecarCoverage(
    {
      version: 1,
      model: "m",
      entries: [
        { contentHash: "old", file: "stale-1.md", vector: [0.1] },
        { contentHash: "same", file: "fresh-1.md", vector: [0.1] },
      ],
    },
    [
      { contentHash: "new", file: "stale-1.md" },
      { contentHash: "same", file: "fresh-1.md" },
      { contentHash: "new", file: "missing-1.md" },
    ],
  );
  assert.deepEqual(mixed, { missing: ["missing-1.md"], stale: ["stale-1.md"], upToDate: ["fresh-1.md"] });
  assert.deepEqual(selectSidecarBackfill(mixed), ["missing-1.md", "stale-1.md"]);
});

// ── 8-9. 降级链与重排接口位（R1/R5） ───────────────────────────────────

test("S8 embedding 后端抛错 → phaseMask=A + degradedReasons 记录 + warn 一次（同因不重复）", async () => {
  const spy = createLoggerSpy();
  const boom = { embed: async () => Promise.reject(new Error("wasm not loaded")), modelId: "m", dim: 1 };
  const { pipeline, scope } = createPipelineFixture({ embedding: boom, logger: spy });

  const first = await pipeline.retrieve({ query: "凭据 401", scope });
  assert.equal(first.status, "ok");
  assert.equal(first.phaseMask, "A", "后端抛错必须降级回纯 BM25（fail-open）");
  assert.deepEqual(first.degradedReasons, ["embedding-unavailable"]);

  const second = await pipeline.retrieve({ query: "凭据 401", scope });
  assert.equal(second.phaseMask, "A");
  // 注入协议行为与无 Phase B 时逐字节一致：候选集合与纯 BM25 序相同（S4b 已钉同构）。
  assert.deepEqual(
    second.candidates.map((candidate) => candidate.entry.filename),
    first.candidates.map((candidate) => candidate.entry.filename),
  );

  const warnings = spy.calls.filter((call) => call.context.event === "memory.recall.degraded");
  assert.equal(warnings.length, 1, "同类降级只 warn 一次，不得刷屏");
  assert.equal(warnings[0].context.module, "core.memory");
  assert.equal(warnings[0].context.reason, "embedding-unavailable");
});

test("S9 reranker 缺省 undefined = Phase C off：零模型调用；接口位存在且可插拔", async () => {
  const rerankCalls = [];
  const reranker = {
    async rerank(input) {
      rerankCalls.push(input);
      return input.candidates.map((candidate) => candidate.id);
    },
  };
  const files = {};
  for (const name of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]) {
    files[pathOf(`${name}.md`)] = {
      content: memoryMarkdown({
        body: `${name} fact about gateway credential rotation.`,
        description: `${name} fact`,
        name: `${name}-slug`,
      }),
      mtimeMs: BASE_MTIME + name.charCodeAt(0),
    };
  }

  // 不传 reranker（缺省）→ 零调用。
  const off = createPipelineFixture({ files });
  await off.pipeline.retrieve({ query: "gateway credential rotation", scope: off.scope });
  assert.equal(off.spy.calls.length, 0, "Phase C off 不得有任何 warn/模型调用痕迹");

  // 传 reranker → 接口可达（Phase C 接线位；触发门槛见 pipeline 装配注释）。
  const on = createPipelineFixture({ files, reranker });
  const result = await on.pipeline.retrieve({
    query: "gateway credential rotation",
    scope: on.scope,
  });
  assert.equal(result.status, "ok");
  if (rerankCalls.length > 0) {
    // 若触发（候选 ≥8 且分差小）：一次 listwise 调用，候选不含文件路径（R5）。
    assert.equal(rerankCalls.length, 1);
    const payload = rerankCalls[0];
    assert.ok(payload.candidates.every((candidate) => candidate.content !== undefined));
    assert.ok(
      payload.candidates.every((candidate) => !JSON.stringify(candidate).includes(".md")),
      "listwise 候选不得泄漏文件路径",
    );
    assert.equal(result.phaseMask, "ABC");
  } else {
    assert.equal(result.phaseMask, "A", "门槛未触发时仍是 Phase A 序（度量先行语义）");
  }
});

// ── 10-12. 会话级通道（R6） ────────────────────────────────────────────

/** 端到端通道 harness：真实文件系统 + tmpdir 数据根 + 最小 runtime mock。 */
async function createChannelFixture(files = {}) {
  const cliStorageRoot = await mkdtemp(join(tmpdir(), "acode-semantic-recall-"));
  // memoryRoot 必须用生产构造工具解析（与通道内 resolveEnabledProjectMemoryRoot 同源），
  // 手拼目录名会静默错位——通道在那个目录里读到空集合，测试现象是「通道返回 null」。
  const { resolveProjectMemoryRoot } = await import("../packages/core/src/memory/project-root.ts");
  const memoryRoot = resolveProjectMemoryRoot({
    cliStorageRoot,
    workspaceIdentity: "channel-test",
    workspacePath: "/work/demo",
  });
  await mkdir(memoryRoot, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = join(memoryRoot, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  const spy = createLoggerSpy();
  const runtime = {
    config: {
      memory: { cliStorageRoot, enabled: true, workspaceIdentity: "channel-test" },
    },
    fileSystemPort: createNodeFileSystemAdapter(),
    isRemoteWorkspace: () => false,
    logger: spy.logger,
    workspaceRoot: "/work/demo",
  };
  return { cliStorageRoot, memoryRoot, runtime, spy };
}

function realUserEntry(content, index) {
  return {
    message: { content, role: "user" },
    metadata: { source: "real_user" },
    ...(index !== undefined ? { id: index } : {}),
  };
}

function assistantEntry(text = "done") {
  return { message: { content: text, role: "assistant" } };
}

function attachmentEntry(source, content) {
  return { content, kind: "attachment", metadata: { source } };
}

test("S10 首轮不检索（零列目录、零注入）；第二轮起 query 为纯文本投影（图片/附件剥离）", async () => {
  const fixture = await createChannelFixture({
    "beta.md": memoryMarkdown({
      body: "主密钥分叉后旧凭据开始返回 401，轮换主密钥即可恢复。",
      description: "凭据 401 的根因是主密钥分叉",
      name: "beta-slug",
    }),
  });
  const traceContext = { queryId: "q", spanId: "s", traceId: "t" };
  try {
    // 静默期判定单元：只有一条真实用户消息、无 assistant 回复 → 首轮。
    assert.equal(isFirstConversationTurn([realUserEntry("第一条任务书")]), true);
    assert.equal(
      isFirstConversationTurn([realUserEntry("第一条"), assistantEntry(), realUserEntry("第二条")]),
      false,
    );

    // 首轮：通道直接跳过，零次列目录（检索层从未触盘）。
    const firstTurn = await buildSemanticMemoryRecallReminderBody(fixture.runtime, {
      entries: [realUserEntry("帮我排查登录问题")],
      traceContext,
    });
    assert.equal(firstTurn, null, "会话首轮不得检索");
    assert.equal(fixture.runtime.memorySemanticRecallChannel, undefined, "首轮连通道实例都不该构造");

    // 第二轮：图片 block 被剥离，text block 才是 query。
    assert.equal(
      latestRealUserPlainTextQuery([
        realUserEntry("第一条"),
        assistantEntry(),
        {
          message: {
            content: [
              { type: "image", source: { data: "xx", mediaType: "image/png" } },
              { text: "凭据 401 怎么排查", type: "text" },
            ],
            role: "user",
          },
          metadata: { source: "real_user" },
        },
      ]),
      "凭据 401 怎么排查",
    );

    const secondTurn = await buildSemanticMemoryRecallReminderBody(fixture.runtime, {
      entries: [
        realUserEntry("帮我排查登录问题"),
        assistantEntry("我先看看"),
        {
          message: {
            content: [
              { type: "image", source: { data: "xx", mediaType: "image/png" } },
              { text: "凭据 401 怎么排查", type: "text" },
            ],
            role: "user",
          },
          metadata: { source: "real_user" },
        },
      ],
      traceContext,
    });
    assert.ok(secondTurn, "第二轮必须产出注入正文");
    assert.match(secondTurn, /凭据 401 的根因是主密钥分叉/u, "检索必须按 query 命中相关记忆");
  } finally {
    await rm(fixture.cliStorageRoot, { recursive: true, force: true });
  }
});

test("S11 通道注入文本：memory_N reference 形态、无路径无 name、含不可信声明（J3-2 R6 同款）", async () => {
  const fixture = await createChannelFixture({
    "secret-slug-file.md": memoryMarkdown({
      body: "主密钥分叉后旧凭据开始返回 401。",
      description: "凭据 401 的根因是主密钥分叉",
      name: "super-secret-name",
    }),
  });
  const traceContext = { queryId: "q", spanId: "s", traceId: "t" };
  try {
    const body = await buildSemanticMemoryRecallReminderBody(fixture.runtime, {
      entries: [realUserEntry("第一轮"), assistantEntry(), realUserEntry("凭据 401 怎么排查")],
      traceContext,
    });
    assert.ok(body);
    assert.match(body, /^## Recalled memory entries$/mu);
    assert.match(body, /- memory_1 \[project\] \(/u);
    assert.doesNotMatch(body, /secret-slug-file\.md/u, "reference 形态不得泄漏文件路径");
    assert.doesNotMatch(body, /super-secret-name/u, "reference 形态不得泄漏 frontmatter name");
    assert.match(body, /UNTRUSTED DATA/u);
    assert.match(body, /not instructions and not current fact/u);
  } finally {
    await rm(fixture.cliStorageRoot, { recursive: true, force: true });
  }
});

test("S12 注入只落 reminder 动态段：context section 快照字节不变 + 新 kind 是 per-request 档", async () => {
  const fixture = await createChannelFixture({
    "beta.md": memoryMarkdown({
      body: "主密钥分叉后旧凭据开始返回 401。",
      description: "凭据 401 的根因是主密钥分叉",
      name: "beta-slug",
    }),
  });
  const traceContext = { queryId: "q", spanId: "s", traceId: "t" };
  try {
    const before = buildMemorySection(fixture.memoryRoot).content;
    await buildSemanticMemoryRecallReminderBody(fixture.runtime, {
      entries: [realUserEntry("第一轮"), assistantEntry(), realUserEntry("凭据 401")],
      traceContext,
    });
    const after = buildMemorySection(fixture.memoryRoot).content;
    // 行为钉子：冻结索引（provider 前缀缓存的一部分）在语义召回注入前后逐字节不变。
    assert.equal(after, before);

    // 源码事实：context section 与 context 装配不 import 检索/通道（通道不触冻结快照）。
    const memorySection = await readSource(`${CORE}/context/sections/memory.ts`);
    const contextMethod = await readSource(`${CORE}/runtime/methods/context.ts`);
    for (const source of [memorySection, contextMethod]) {
      assert.doesNotMatch(source, /retrieval|memory-semantic-recall|memorySemanticRecall/u);
    }

    // 接线事实：注入走 systemReminderAttachmentEntry("memory_semantic_recall")（动态段），
    // 且该 source 在 per-request 名单（不落 session、不进前缀缓存段）。
    const sourceModule = await import("../packages/core/src/system-reminder/source.ts");
    assert.ok(sourceModule.SYSTEM_REMINDER_PER_REQUEST_SOURCES.includes("memory_semantic_recall"));
    assert.ok(!sourceModule.SYSTEM_REMINDER_PERSISTED_SOURCES.includes("memory_semantic_recall"));
    const turnLoop = await readSource(`${CORE}/runtime/methods/turn-loop.ts`);
    assert.match(
      turnLoop,
      /systemReminderAttachmentEntry\("memory_semantic_recall", semanticRecallBody\)/u,
    );
    assert.match(turnLoop, /state\.modelStepCount === 0/u, "注入必须限定在 turn 的首个模型请求");
  } finally {
    await rm(fixture.cliStorageRoot, { recursive: true, force: true });
  }
});

// ── 13. 四层去重全可达（J3-2 场景 9-11 原样重放 + 层 4） ────────────────

test("S13a J3-2 层 1→2→3 链条原样可达（同一条记忆始终不重复注入）", async () => {
  const { injector, scope, time } = createPipelineFixture();
  const inject = () => injector.inject({ ...scope, presentation: "reference" });

  assert.equal((await inject()).status, "injected");
  time.advance(30_000);
  assert.deepEqual(pickReason(await inject()), { reason: "same-block", status: "suppressed" });
  time.advance(70_000); // t=100s：层 2 接管
  assert.deepEqual(pickReason(await inject()), { reason: "set-overlap", status: "suppressed" });
  time.advance(100_000); // t=200s：层 3 接管
  assert.deepEqual(pickReason(await inject()), { reason: "entry-ttl", status: "suppressed" });
});

test("S13b 层 4（F3）：同 filename 微改写 10 分钟内二次注入 → 该条剔除、其余条目照常；10 分钟后放行", async () => {
  const { fs, injector, scope, time } = createPipelineFixture();
  const inject = () => injector.inject({ ...scope, presentation: "reference" });

  const first = await inject();
  assert.equal(first.status, "injected");
  assert.equal(first.snapshot.entries.length, 2);

  // 微改写：+1 空格换 contentHash——层 1/2/3 的 key 全部穿透（F3 登记的放大器形态）。
  fs.write(
    pathOf("alpha.md"),
    memoryMarkdown({ body: "One fact. ", description: "Alpha fact", name: "alpha-slug" }),
    { mtimeMs: BASE_MTIME + 5_000 },
  );

  time.advance(30_000);
  const rewritten = await inject();
  assert.equal(rewritten.status, "injected", "层 4 是条目级剔除，不是整包抑制");
  assert.deepEqual(
    rewritten.snapshot.entries.map((entry) => entry.filename),
    ["beta.md"],
    "10 分钟内同 filename 且内容已变的条目必须被剔除，剩余条目照常注入",
  );
  assert.match(rewritten.text, /凭据 401 的根因是主密钥分叉/u, "剩余条目（beta）照常渲染");
  assert.doesNotMatch(rewritten.text, /Alpha fact|One fact/u, "被剔除的条目不得出现在注入文本里");

  // 10 分钟窗口过后：同一改写条目重新可达（放大器被压到每 10 分钟最多一次）。
  time.advance(10 * 60_000 + 1_000);
  const afterInterval = await inject();
  assert.equal(afterInterval.status, "injected");
  assert.deepEqual(
    afterInterval.snapshot.entries.map((entry) => entry.filename).sort(),
    ["alpha.md", "beta.md"],
  );
});

test("S13c 层 4 只打微改写：内容未变条目的部分集合注入（J3-2 场景 11 的语义）不受影响", async () => {
  const files = {};
  for (const name of ["a", "b", "c", "d", "e"]) {
    files[pathOf(`${name}.md`)] = {
      content: memoryMarkdown({ description: `${name} fact`, name: `${name}-slug` }),
      mtimeMs: BASE_MTIME + name.charCodeAt(0),
    };
  }
  const { injector, scope, time } = createPipelineFixture({ files });
  const inject = () => injector.inject({ ...scope, presentation: "reference" });
  assert.equal((await inject()).status, "injected");

  // 200s 后注入子集 {a,b}（未改写）：层 3 抑制（J3-2 既有语义，层 4 不得抢先）。
  time.advance(200_000);
  assert.deepEqual(pickReason(await inject()), { reason: "entry-ttl", status: "suppressed" });

  // 45min TTL 过后重新浮现（层 4 对未改写条目不设限）。
  time.advance(45 * 60_000 + 1_000);
  assert.equal((await inject()).status, "injected");
});

test("S13d Extraction 通道（dedupe:false）不受层 4 影响：改写后的清单立即重新可见", async () => {
  const { fs, injector, scope, time } = createPipelineFixture();
  const request = { ...scope, dedupe: false, presentation: "target" };
  assert.equal((await injector.inject(request)).status, "injected");
  fs.write(
    pathOf("alpha.md"),
    memoryMarkdown({ body: "One fact. ", description: "Alpha fact", name: "alpha-slug" }),
    { mtimeMs: BASE_MTIME + 5_000 },
  );
  time.advance(1_000);
  // Extraction 是全新子代理上下文：filename 限速若在这里生效，第二次运行将看不到
  // 刚被自己更新的文件 → 直接产生重复记忆文件（J3-2 R5 的反对理由对层 4 同样成立）。
  const second = await injector.inject(request);
  assert.equal(second.status, "injected");
  assert.equal(second.snapshot.entries.length, 2);
});

function pickReason(result) {
  return "reason" in result ? { reason: result.reason, status: result.status } : { status: result.status };
}

// ── 14. 时钟债（R7/F4） ───────────────────────────────────────────────

test("S14 墙钟回拨不影响新鲜度判定（单调钟）；capturedAtMs > now → stale-snapshot 拒绝", async () => {
  // 默认 now（缺省实现）已换单调钟：桩掉 Date.now 拨回 1 小时，新鲜度判定不受影响。
  const fixture = createPipelineFixture({ clock: undefined, logger: undefined });
  const captured = await fixture.injector.capture(fixture.scope);
  assert.equal(captured.status, "captured");

  const realDateNow = Date.now;
  try {
    Date.now = () => realDateNow() - 3_600_000; // 墙钟回拨 1 小时
    const verification = await fixture.injector.verify(captured.snapshot, fixture.scope);
    assert.equal(verification.status, "verified", "墙钟回拨不得影响单调钟驱动的新鲜度判定");
  } finally {
    Date.now = realDateNow;
  }

  // capturedAtMs > now：时钟序列被破坏（now 被回拨/快照被外部构造）→ stale-snapshot。
  const forged = { ...captured.snapshot, capturedAtMs: captured.snapshot.capturedAtMs + 1 };
  assert.deepEqual(await fixture.injector.verify(forged, fixture.scope), {
    status: "rejected",
    reason: "stale-snapshot",
  });
});

// ── 15. 协议不变（红线：Extraction 通道行为不变） ──────────────────────

test("S15 Extraction 通道行为不变：dedupe:false + target 形态仍在位；tags 不进注入签名", async () => {
  const extraction = await readSource(`${CORE}/runtime/helpers/project-memory-extraction.ts`);
  assert.match(extraction, /dedupe: false,/u);
  assert.match(extraction, /presentation: "target",/u);

  // R2 的 tags 只进检索文档表示，不进 J3-2 注入签名（协议面零变化）。
  const pending = await readSource(`${CORE}/memory/recall/pending.ts`);
  assert.doesNotMatch(pending, /tags/u, "tags 不得进入注入协议层");
  const manifest = await readSource(`${CORE}/memory/recall/manifest.ts`);
  assert.match(manifest, /tags\?: string\[\]/u, "frontmatter tags 解析只服务检索层");

  // identity 口径不变。
  assert.equal(
    resolveMemoryIdentityKey({ workspaceIdentity: "  id  ", workspacePath: "/p" }),
    "id",
  );
});

// ── 16. 度量账本（R8） ────────────────────────────────────────────────

test("S16 各事件分类计数落 JSONL（按天滚动）；content/description 全文绝不出现", async () => {
  const metricsRoot = await mkdtemp(join(tmpdir(), "acode-recall-metrics-"));
  try {
    let day = 0;
    const ledger = createRecallMetricsLedger({
      metricsRoot,
      now: () => new Date(Date.UTC(2026, 9, 4 + day)),
    });
    await ledger.record({
      candidateCount: 8,
      durationMs: 12,
      event: "retrieval",
      phaseMask: "A",
      topK: 8,
    });
    await ledger.record({ entryCount: 3, event: "injected", queryHash: recallQueryHash("凭据 401") });
    await ledger.record({ event: "suppressed", reason: "filename-throttle" });
    await ledger.record({ event: "discarded", reason: "stale-snapshot" });
    await ledger.record({ backfilled: 20, event: "embedding", model: "minilm-l6-v2-int8-384" });
    day = 1; // 滚动按天：下一条落第二天的文件。
    await ledger.record({ event: "suppressed", reason: "entry-ttl" });

    const files = (await readdir(metricsRoot)).sort();
    assert.deepEqual(files, ["recall-2026-10-04.jsonl", "recall-2026-10-05.jsonl"]);
    const dayOne = (await readFile(join(metricsRoot, files[0]), "utf8")).trim().split("\n");
    assert.equal(dayOne.length, 5);
    const events = dayOne.map((line) => JSON.parse(line));
    assert.deepEqual(
      events.map((event) => event.event),
      ["retrieval", "injected", "suppressed", "discarded", "embedding"],
    );
    assert.equal(events[0].phaseMask, "A");
    assert.equal(events[1].queryHash.length, 16, "queryHash 是 sha256 前 16 位");

    // 全文不落账本：query 原文与记忆正文都不出现在任何度量行里。
    const allLines = `${dayOne.join("\n")}\n${await readFile(join(metricsRoot, files[1]), "utf8")}`;
    assert.doesNotMatch(allLines, /凭据 401/u, "query 原文不得进度量账本（只落 hash）");
    assert.doesNotMatch(allLines, /description|content/u, "度量事件结构没有正文字段");

    // 源码断言：事件联合的字段面就是分类计数与 hash，不存在正文序列化路径。
    const metricsSource = await readSource(`${CORE}/memory/recall/retrieval/metrics.ts`);
    assert.match(metricsSource, /event: "retrieval";/u);
    assert.match(metricsSource, /queryHash: string/u);
    assert.doesNotMatch(
      metricsSource,
      /event: "(retrieval|injected|suppressed|discarded|embedding)";[\s\S]{0,200}(content|description|text): string/u,
      "度量事件不得携带正文字段",
    );
  } finally {
    await rm(metricsRoot, { recursive: true, force: true });
  }
});

test("S16b 通道端到端落度量：injected/suppressed 事件带 queryHash，账本不含正文", async () => {
  const fixture = await createChannelFixture({
    "beta.md": memoryMarkdown({
      body: "主密钥分叉后旧凭据开始返回 401。",
      description: "凭据 401 的根因是主密钥分叉",
      name: "beta-slug",
    }),
  });
  const traceContext = { queryId: "q", spanId: "s", traceId: "t" };
  try {
    const entries = () => [
      realUserEntry("第一轮"),
      assistantEntry(),
      realUserEntry("凭据 401 怎么排查"),
    ];
    const first = await buildSemanticMemoryRecallReminderBody(fixture.runtime, {
      entries: entries(),
      traceContext,
    });
    assert.ok(first);
    // 同一 turn 内容立即再跑一次：四层去重抑制（层 1），suppressed 事件落账本。
    const second = await buildSemanticMemoryRecallReminderBody(fixture.runtime, {
      entries: entries(),
      traceContext,
    });
    assert.equal(second, null);

    const metricsDir = join(fixture.cliStorageRoot, "memories", "metrics");
    const written = await readdir(metricsDir);
    assert.equal(written.length, 1);
    const raw = await readFile(join(metricsDir, written[0]), "utf8");
    const events = raw.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(
      events.map((event) => event.event),
      ["retrieval", "injected", "retrieval", "suppressed"],
    );
    assert.equal(events[1].queryHash, recallQueryHash("凭据 401 怎么排查"));
    assert.equal(events[3].reason, "same-block");
    assert.doesNotMatch(raw, /凭据 401 怎么排查|主密钥分叉/u, "正文与 query 原文不得落账本");
  } finally {
    await rm(fixture.cliStorageRoot, { recursive: true, force: true });
  }
});

// ── 常量钉住（spec 常量表逐字一致） ────────────────────────────────────

test("S17 常量与 spec 常量表逐字一致（含 R7 层 4 的 FILENAME_MIN_INTERVAL_MS）", async () => {
  const constants = await readSource(`${CORE}/memory/recall/retrieval/constants.ts`);
  const pending = await readSource(`${CORE}/memory/recall/pending.ts`);
  const spec = await readSource("apps/acode-cli/specs/memory-semantic-recall.md");

  const expected = [
    ["RECALL_TOP_K", "8"],
    ["RECALL_FIRST_TURN_SKIP", "true"],
    ["BM25_K1", "1.2"],
    ["BM25_B", "0.75"],
    ["RRF_K", "60"],
    ["RRF_POOL_MULTIPLIER", "5"],
    ["EMBEDDING_MODEL_ID", '"minilm-l6-v2-int8-384"'],
    ["EMBEDDING_DIM", "384"],
    ["SIDECAR_BACKFILL_LIMIT_PER_RETRIEVAL", "20"],
    ["RERANK_MIN_CANDIDATES", "8"],
    ["RERANK_SCORE_SPREAD", "0.5"],
    ["RERANK_TIMEOUT_MS", "10_000"],
  ];
  for (const [name, literal] of expected) {
    assert.ok(constants.includes(`${name}: ${literal}`), `${name} 源码值与常量表不一致`);
    assert.ok(spec.includes(`\`${name}\``), `spec 常量表缺少 ${name}`);
  }
  assert.match(pending, /FILENAME_MIN_INTERVAL_MS: 10 \* 60_000,/u);
  assert.ok(spec.includes("`FILENAME_MIN_INTERVAL_MS`"), "spec 常量表缺少 FILENAME_MIN_INTERVAL_MS");
  // K1 不改 J3-2 既有常量（红线：注入协议零回归由旧测试 D5 钉住，此处防误删）。
  for (const line of [
    "ENTRY_TTL_MS: 45 * 60_000,",
    "OVERLAP_COOLDOWN_MS: 180_000,",
    "PENDING_FRESHNESS_MS: 120_000,",
    "SAME_BLOCK_COOLDOWN_MS: 90_000,",
  ]) {
    assert.ok(pending.includes(line), `J3-2 常量被动了：${line}`);
  }
});

// ── 第三方归属 ────────────────────────────────────────────────────────

test("S18 retrieval 新文件头注明 jcode 机制参照（spec 第三方归属章）", async () => {
  for (const file of ["pipeline.ts", "constants.ts", "tokenize.ts", "bm25.ts", "rrf.ts", "sidecar.ts", "embedding.ts", "rerank.ts"]) {
    const source = await readSource(`${CORE}/memory/recall/retrieval/${file}`);
    assert.match(source, /jcode \(MIT/u, `${file} 缺少第三方归属头`);
  }
});
