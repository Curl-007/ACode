import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * WI-3 验收测试：记忆写侧生命周期三件套（specs/memory-semantic-recall.md R10-R13，
 * 机制移植自 oh-my-pi (MIT) packages/mnemopi）。
 *
 * 覆盖（spec 验收场景 17-23 + R11/R13 单元面）：
 *  17  衰减函数：参数表逐格、eta 点位（age=eta → exp(-1) 与 k 无关）、未来 mtime → 1、
 *      type 缺失 → general 兜底、下限混合端点
 *  18  veracity 权重：四档查表、非法/缺失 → unknown 中性、合并方向（非 unknown 覆盖）
 *  19  失效过滤：superseded-by 非空不可见、valid-until 过期不可见/未来可见/不可解析
 *      fail-open、全失效 → 零候选且 status=ok
 *  20  机械去重：归一化哈希命中 → 幸存者合并（importance 取高、veracity 非空覆盖、
 *      valid-until/type/description 新写覆盖、name/superseded-by 保留、正文保留既有）、
 *      新写文件删除；未命中原样不动；MEMORY.md 不参与
 *  21  veracity 机械兜底：Extraction 循环 Write 落盘缺 veracity → 补 extracted；
 *      模型已写的值不覆盖（runMemoryAgentLoop 集成）
 *  22  recall 排序集成：新近 + user_stated 上浮陈旧 + 无 veracity，陈旧仍在候选（floor
 *      不清零）
 *  23  存量兼容：无任何新字段的记忆文件照常检索、不过滤、中性权重
 */

const {
  DECAY_SCORE_FLOOR,
  WEIBULL_PARAMS,
  blendDecayIntoScore,
  memoryAgeHours,
  weibullDecayFactor,
} = await import("../packages/core/src/memory/decay.ts");
const {
  MEMORY_VERACITY_LEVELS,
  VERACITY_WEIGHTS,
  mergeVeracity,
  parseMemoryVeracity,
  veracityWeightFor,
} = await import("../packages/core/src/memory/veracity.ts");
const {
  MEMORY_IMPORTANCE_DEFAULT,
  isMemoryEntryLifecycleFiltered,
  mergeMemoryFrontmatterFields,
  parseMemoryFrontmatterBlock,
  parseMemoryImportance,
  parseMemoryTimestampMs,
  readMemoryLifecycleFields,
  serializeMemoryFrontmatterBlock,
} = await import("../packages/core/src/memory/lifecycle-frontmatter.ts");
const {
  enforceMemoryWriteLifecycle,
  normalizedContentHash,
} = await import("../packages/core/src/memory/dedupe.ts");
const { parseMemoryFrontmatter } = await import(
  "../packages/core/src/memory/recall/manifest.ts"
);
const { createMemoryRecallInjector } = await import(
  "../packages/core/src/memory/recall/pending.ts"
);
const { createMemoryRetrievalPipeline } = await import(
  "../packages/core/src/memory/recall/retrieval/index.ts"
);
const { buildMemoryExtractionPrompt } = await import("../packages/core/src/memory/extraction.ts");
const { runMemoryAgentLoop } = await import("../packages/core/src/memory/memory-agent-loop.ts");

// ── 夹具 ─────────────────────────────────────────────────────────────

const ROOT = "/store/memories/projects/demo-0123456789abcdef/memory";
const IDENTITY_KEY = "remote:ssh/host:/repos/demo";
const NOW = 1_760_000_000_000;
const HOUR = 3_600_000;

const pathOf = (name) => `${ROOT}/${name}`;

function memoryMarkdown({
  body = "One fact.",
  description,
  importance,
  name,
  supersededBy,
  type = "project",
  validUntil,
  veracity,
}) {
  const lines = ["---", `name: ${name}`];
  if (description !== undefined) lines.push(`description: ${description}`);
  if (importance !== undefined) lines.push(`importance: ${importance}`);
  if (veracity !== undefined) lines.push(`veracity: ${veracity}`);
  if (supersededBy !== undefined) lines.push(`superseded-by: ${supersededBy}`);
  if (validUntil !== undefined) lines.push(`valid-until: ${validUntil}`);
  lines.push("metadata:", `  type: ${type}`, "---", "", body, "");
  return lines.join("\n");
}

/** 可变内存 FileSystemPort（写侧测试需要 writeTextFile/removeFile）。 */
function createMutableMemoryFs(initialFiles = {}) {
  const files = new Map();
  // 真实适配器对路径做平台归一（win32 反斜杠 ↔ 正斜杠等价）；路径策略解析出的
  // 绝对路径是平台形态，桩件按同口径归一到正斜杠键。
  const key = (path) => path.replace(/\\/gu, "/");
  for (const [path, value] of Object.entries(initialFiles)) {
    files.set(key(path), {
      content: typeof value === "string" ? value : value.content,
      mtimeMs: (typeof value === "string" ? undefined : value.mtimeMs) ?? NOW,
    });
  }
  const port = {
    async listDirectory({ path }) {
      const prefix = `${key(path)}/`;
      const entries = [];
      const seenDirectories = new Set();
      for (const filePath of files.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash >= 0) {
          const directoryPath = prefix + rest.slice(0, slash);
          if (!seenDirectories.has(directoryPath)) {
            seenDirectories.add(directoryPath);
            entries.push({ kind: "directory", path: directoryPath });
          }
          continue;
        }
        entries.push({ kind: "file", path: filePath });
      }
      return { entries, numEntries: entries.length, path };
    },
    async stat({ path }) {
      const entry = files.get(key(path));
      if (!entry) throw enoent(path);
      return {
        kind: "file",
        mtimeMs: entry.mtimeMs,
        path,
        sizeBytes: Buffer.byteLength(entry.content, "utf8"),
      };
    },
    async readTextFile({ path }) {
      const entry = files.get(key(path));
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
    async writeTextFile({ path, content }) {
      files.set(key(path), { content, mtimeMs: NOW + 1 });
      return { bytesWritten: Buffer.byteLength(content, "utf8"), path };
    },
    async removeFile({ path }) {
      const removed = files.delete(key(path));
      return { path, removed };
    },
  };
  return {
    port,
    exists: (path) => files.has(key(path)),
    read: (path) => files.get(key(path))?.content,
    write: (path, content, mtimeMs = NOW) => files.set(key(path), { content, mtimeMs }),
  };
}

/** 只读内存 FS（检索管线测试用）：initial 为 { 路径: { content, mtimeMs } }。 */
function createReadOnlyMemoryFs(initialFiles = {}) {
  const mutable = createMutableMemoryFs(initialFiles);
  const { removeFile: _removed, writeTextFile: _written, ...readOnlyPort } = mutable.port;
  return { port: readOnlyPort, ...mutable };
}

function enoent(path) {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
    code: "ENOENT",
  });
}

function createLoggerSpy() {
  const calls = [];
  return {
    calls,
    logger: {
      debug: () => {},
      error: () => {},
      info: () => {},
      warn: (message, context) => calls.push({ context, message }),
    },
  };
}

function createPipelineFixture(files) {
  const fs = createReadOnlyMemoryFs(files);
  const spy = createLoggerSpy();
  const injector = createMemoryRecallInjector({
    fileSystem: fs.port,
    logger: spy.logger,
    now: () => NOW,
  });
  const pipeline = createMemoryRetrievalPipeline({
    fileSystem: fs.port,
    injector,
    logger: spy.logger,
    now: () => NOW,
  });
  return { fs, pipeline, scope: { identityKey: IDENTITY_KEY, memoryRoot: ROOT }, spy };
}

// ── 17. Weibull 衰减（R10） ──────────────────────────────────────────

test("17a Weibull 参数表与 spec R10 表逐格一致（可调常量钉住）", () => {
  assert.deepEqual(WEIBULL_PARAMS.user, { k: 0.4, eta: 4380.0 });
  assert.deepEqual(WEIBULL_PARAMS.feedback, { k: 0.9, eta: 480.0 });
  assert.deepEqual(WEIBULL_PARAMS.project, { k: 0.85, eta: 1080.0 });
  assert.deepEqual(WEIBULL_PARAMS.reference, { k: 0.75, eta: 2160.0 });
  assert.deepEqual(WEIBULL_PARAMS.general, { k: 1.0, eta: 168.0 });
  assert.equal(DECAY_SCORE_FLOOR, 0.7);
});

test("17b eta 点位：age = eta 时 decay = exp(-1)（与 k 无关），各 type 相同", () => {
  for (const [type, { eta }] of Object.entries(WEIBULL_PARAMS)) {
    assert.ok(
      Math.abs(weibullDecayFactor(eta, type === "general" ? undefined : type) - Math.exp(-1)) <
        1e-12,
      `type=${type} 在 eta 点位应衰减到 exp(-1)`,
    );
  }
});

test("17c k 形状生效：同 age 下公式直算对照（同式重算而非魔法数）", () => {
  const expect = (ageHours, type) => {
    const { k, eta } = WEIBULL_PARAMS[type];
    return Math.exp(-((ageHours / eta) ** k));
  };
  assert.ok(Math.abs(weibullDecayFactor(720, "user") - expect(720, "user")) < 1e-12);
  assert.ok(Math.abs(weibullDecayFactor(240, "feedback") - expect(240, "feedback")) < 1e-12);
  assert.ok(Math.abs(weibullDecayFactor(500, "project") - expect(500, "project")) < 1e-12);
  assert.ok(Math.abs(weibullDecayFactor(3000, "reference") - expect(3000, "reference")) < 1e-12);
  // 同一 age 下 user（k 小 eta 大）显著比 feedback（k 大 eta 小）保留得多。
  assert.ok(weibullDecayFactor(720, "user") > weibullDecayFactor(720, "feedback"));
});

test("17d 边界：未来/零/非有限 age → 1.0；type 缺失 → general 兜底", () => {
  assert.equal(weibullDecayFactor(-5, "project"), 1.0);
  assert.equal(weibullDecayFactor(0, "project"), 1.0);
  assert.equal(weibullDecayFactor(Number.NaN, "project"), 1.0);
  assert.ok(Math.abs(weibullDecayFactor(168, undefined) - Math.exp(-1)) < 1e-12);
  assert.ok(Math.abs(weibullDecayFactor(168, "nonexistent-type") - Math.exp(-1)) < 1e-12);
});

test("17e 下限混合端点与夹紧；memoryAgeHours 口径", () => {
  assert.equal(blendDecayIntoScore(2, 1), 2);
  assert.equal(blendDecayIntoScore(2, 0), 2 * DECAY_SCORE_FLOOR);
  assert.equal(blendDecayIntoScore(1, 5), 1); // 越界夹紧到 1
  assert.equal(blendDecayIntoScore(1, -1), DECAY_SCORE_FLOOR); // 越界夹紧到 0
  assert.equal(memoryAgeHours(NOW - 2 * HOUR, NOW), 2);
  assert.equal(memoryAgeHours(undefined, NOW), 0);
});

// ── 18. veracity 权重（R11） ─────────────────────────────────────────

test("18a 四档权重表与 spec 一致；unknown 为中性 1.0", () => {
  assert.deepEqual(MEMORY_VERACITY_LEVELS, ["user_stated", "tool_observed", "extracted", "unknown"]);
  assert.equal(VERACITY_WEIGHTS.user_stated, 1.1);
  assert.equal(VERACITY_WEIGHTS.tool_observed, 1.05);
  assert.equal(VERACITY_WEIGHTS.extracted, 1.0);
  assert.equal(VERACITY_WEIGHTS.unknown, 1.0);
});

test("18b 解析：非法/缺失值收敛到 unknown（中性）", () => {
  assert.equal(parseMemoryVeracity("user_stated"), "user_stated");
  assert.equal(parseMemoryVeracity("tool_observed"), "tool_observed");
  assert.equal(parseMemoryVeracity("extracted"), "extracted");
  assert.equal(parseMemoryVeracity("unknown"), "unknown");
  assert.equal(parseMemoryVeracity("bogus"), "unknown");
  assert.equal(parseMemoryVeracity(42), "unknown");
  assert.equal(parseMemoryVeracity(undefined), "unknown");
  assert.equal(veracityWeightFor(undefined), 1.0);
  assert.equal(veracityWeightFor("bogus-literal"), 1.0);
});

test("18c 合并方向：新写非 unknown 覆盖，否则保留既有（omp CASE WHEN 语义）", () => {
  assert.equal(mergeVeracity("extracted", "user_stated"), "user_stated");
  assert.equal(mergeVeracity("user_stated", "unknown"), "user_stated");
  assert.equal(mergeVeracity("extracted", undefined), "extracted");
  assert.equal(mergeVeracity(undefined, "unknown"), undefined);
  assert.equal(mergeVeracity(undefined, "user_stated"), "user_stated");
});

// ── 19. 失效过滤（R12） ──────────────────────────────────────────────

test("19a 失效判定单元：superseded-by 非空 / valid-until 到期；空串与坏数据 fail-open", () => {
  assert.equal(isMemoryEntryLifecycleFiltered({ supersededBy: "fresh-fact" }, NOW), true);
  assert.equal(isMemoryEntryLifecycleFiltered({ supersededBy: "" }, NOW), false);
  assert.equal(isMemoryEntryLifecycleFiltered({ supersededBy: "   " }, NOW), false);
  assert.equal(
    isMemoryEntryLifecycleFiltered({ validUntil: new Date(NOW - 1).toISOString() }, NOW),
    true,
  );
  assert.equal(
    isMemoryEntryLifecycleFiltered({ validUntil: new Date(NOW + 1).toISOString() }, NOW),
    false,
  );
  // 到期边界：validUntil == now 视为过期（omp `valid_until > now` 的可见条件）。
  assert.equal(isMemoryEntryLifecycleFiltered({ validUntil: new Date(NOW).toISOString() }, NOW), true);
  assert.equal(isMemoryEntryLifecycleFiltered({ validUntil: "not-a-date" }, NOW), false);
  assert.equal(isMemoryEntryLifecycleFiltered({ validUntil: "" }, NOW), false);
  assert.equal(isMemoryEntryLifecycleFiltered({}, NOW), false);
});

test("19b parseMemoryTimestampMs：ISO 字符串与 Date 可解析，其余 undefined", () => {
  assert.equal(parseMemoryTimestampMs("2026-01-01T00:00:00.000Z"), Date.parse("2026-01-01T00:00:00.000Z"));
  assert.equal(parseMemoryTimestampMs(new Date(NOW)), NOW);
  assert.equal(parseMemoryTimestampMs("garbage"), undefined);
  assert.equal(parseMemoryTimestampMs(123), undefined);
  assert.equal(parseMemoryTimestampMs(undefined), undefined);
});

test("19c 检索集成：superseded-by 条目不可见，正常条目照常命中", async () => {
  const { pipeline, scope } = createPipelineFixture({
    [pathOf("hidden.md")]: {
      content: memoryMarkdown({
        body: "quantum widget calibration requires cold start",
        name: "hidden-fact",
        supersededBy: "fresh-fact",
      }),
      mtimeMs: NOW - HOUR,
    },
    [pathOf("keep.md")]: {
      content: memoryMarkdown({
        body: "quantum widget calibration needs warm cache",
        name: "keep-fact",
      }),
      mtimeMs: NOW - HOUR,
    },
  });
  const result = await pipeline.retrieve({ query: "quantum widget calibration", scope });
  assert.equal(result.status, "ok");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].entry.filename, "keep.md");
});

test("19d 检索集成：valid-until 过去隐藏、未来可见、不可解析 fail-open", async () => {
  const past = createPipelineFixture({
    [pathOf("expired.md")]: {
      content: memoryMarkdown({
        body: "legacy bastion hostname golden",
        name: "expired-fact",
        validUntil: "2020-01-01T00:00:00.000Z",
      }),
      mtimeMs: NOW - HOUR,
    },
  });
  const pastResult = await past.pipeline.retrieve({ query: "legacy bastion hostname", scope: past.scope });
  assert.equal(pastResult.status, "ok");
  assert.equal(pastResult.candidates.length, 0);

  const futureValidUntil = "2999-01-01T00:00:00.000Z";
  const future = createPipelineFixture({
    [pathOf("lease.md")]: {
      content: memoryMarkdown({
        body: "legacy bastion hostname golden",
        name: "lease-fact",
        validUntil: futureValidUntil,
      }),
      mtimeMs: NOW - HOUR,
    },
  });
  const futureResult = await future.pipeline.retrieve({ query: "legacy bastion hostname", scope: future.scope });
  assert.equal(futureResult.candidates.length, 1);

  const broken = createPipelineFixture({
    [pathOf("broken.md")]: {
      content: memoryMarkdown({
        body: "legacy bastion hostname golden",
        name: "broken-fact",
        validUntil: "not-a-date",
      }),
      mtimeMs: NOW - HOUR,
    },
  });
  const brokenResult = await broken.pipeline.retrieve({ query: "legacy bastion hostname", scope: broken.scope });
  assert.equal(brokenResult.candidates.length, 1);
});

test("19e 全部条目失效 → 零候选且 status=ok（不是 rejected：存储可读只是没有可见记忆）", async () => {
  const { pipeline, scope } = createPipelineFixture({
    [pathOf("one.md")]: {
      content: memoryMarkdown({ body: "solo witness", name: "one", supersededBy: "two" }),
      mtimeMs: NOW - HOUR,
    },
  });
  const result = await pipeline.retrieve({ query: "solo witness", scope });
  assert.deepEqual(result, { candidates: [], degradedReasons: [], phaseMask: "A", status: "ok" });
});

// ── 22. recall 排序集成（R10/R11） ───────────────────────────────────

test("22 集成：新近 + user_stated 上浮陈旧 + 无 veracity；陈旧仍在候选（floor 不清零）", async () => {
  const body = "deploy token rotation happens on tuesdays";
  const { pipeline, scope } = createPipelineFixture({
    [pathOf("old.md")]: {
      content: memoryMarkdown({ body, name: "old-fact", type: "project" }),
      mtimeMs: NOW - 720 * HOUR, // 30 天前：project eta=1080h，衰减显著
    },
    [pathOf("new.md")]: {
      content: memoryMarkdown({
        body,
        name: "new-fact",
        type: "project",
        veracity: "user_stated",
      }),
      mtimeMs: NOW - HOUR, // 1 小时前：几乎不衰减，且 ×1.1
    },
  });
  const result = await pipeline.retrieve({ query: "deploy token rotation", scope });
  assert.equal(result.status, "ok");
  assert.equal(result.candidates.length, 2, "floor 混合保证陈旧条目仍可见（不清零）");
  assert.equal(result.candidates[0].entry.filename, "new.md");
  assert.equal(result.candidates[1].entry.filename, "old.md");
  assert.ok(result.candidates[0].fusedScore > result.candidates[1].fusedScore);
});

// ── 23. 存量兼容（R10-R13） ──────────────────────────────────────────

test("23 存量兼容：无任何新字段的记忆照常检索、不过滤、排序确定", async () => {
  const { pipeline, scope } = createPipelineFixture({
    [pathOf("stock.md")]: {
      content: memoryMarkdown({
        body: "stock memory about postgres tuning",
        description: "postgres tuning",
        name: "stock-fact",
      }),
      mtimeMs: NOW - HOUR,
    },
  });
  const result = await pipeline.retrieve({ query: "postgres tuning", scope });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].entry.filename, "stock.md");

  const frontmatter = parseMemoryFrontmatter(
    memoryMarkdown({ name: "stock-fact", description: "d" }),
  );
  assert.equal(frontmatter.veracity, undefined);
  assert.equal(frontmatter.importance, undefined);
  assert.equal(frontmatter.supersededBy, undefined);
  assert.equal(frontmatter.validUntil, undefined);
  assert.equal(frontmatter.type, "project");
  assert.equal(frontmatter.name, "stock-fact");
  // 无 veracity 字段 → 检索乘权走 unknown 中性 1.0（不因缺字段降权）。
  assert.equal(veracityWeightFor(frontmatter.veracity), 1.0);
});

// ── 20. 机械去重合并（R13） ──────────────────────────────────────────

test("20a 归一化哈希：大小写/空白/正文体例不敏感，frontmatter 差异不参与", () => {
  const base = memoryMarkdown({ body: "Alpha  BODY\n\nsecond line", name: "one" });
  const reformatted = memoryMarkdown({
    body: "alpha body\nsecond   line",
    description: "different description",
    name: "two",
    type: "user",
  });
  assert.equal(normalizedContentHash(base), normalizedContentHash(reformatted));
  assert.notEqual(
    normalizedContentHash(base),
    normalizedContentHash(memoryMarkdown({ body: "Totally different fact.", name: "three" })),
  );
});

test("20b 去重命中：幸存者保留文件名与正文，importance 取高、veracity 非空覆盖，新写删除", async () => {
  const fs = createMutableMemoryFs({
    [pathOf("alpha.md")]: {
      content: memoryMarkdown({
        body: "Alpha  BODY\n\nsecond line",
        importance: 0.4,
        name: "alpha-slug",
        type: "project",
        veracity: "extracted",
      }),
      mtimeMs: NOW - 2 * HOUR,
    },
  });
  // 新写文件：归一化后与 alpha.md 重复（只有体例/frontmatter 不同）。
  fs.write(
    pathOf("beta.md"),
    memoryMarkdown({
      body: "alpha body\nsecond line",
      importance: 0.7,
      name: "beta-slug",
      type: "user",
      validUntil: "2999-01-01T00:00:00.000Z",
      veracity: "user_stated",
    }),
    NOW,
  );

  const outcome = await enforceMemoryWriteLifecycle(
    { defaultVeracity: "extracted", fileSystem: fs.port, memoryRoot: ROOT },
    pathOf("beta.md"),
  );

  assert.equal(outcome.mergedInto, "alpha.md");
  assert.deepEqual(outcome.duplicatesRemoved, ["beta.md"]);
  assert.equal(outcome.veracityFilled, false, "beta 自带 veracity，无需兜底补写");
  assert.equal(fs.exists(pathOf("beta.md")), false, "重复文件被删除");

  const merged = parseMemoryFrontmatterBlock(fs.read(pathOf("alpha.md")));
  assert.ok(merged, "幸存者 frontmatter 仍可解析");
  assert.equal(readMemoryLifecycleFields(merged.record).importance, 0.7, "importance 取高");
  assert.equal(readMemoryLifecycleFields(merged.record).veracity, "user_stated", "非空覆盖");
  assert.equal(
    readMemoryLifecycleFields(merged.record).validUntil,
    "2999-01-01T00:00:00.000Z",
    "valid-until 新写存在则覆盖",
  );
  assert.equal(merged.record.metadata?.type ?? merged.record.type, "user", "type 新写存在则覆盖（写入位置跟随既有文件的 metadata 嵌套）");
  assert.equal(merged.record.name, "alpha-slug", "name（互链身份）保留既有");
  assert.ok(merged.body.includes("Alpha  BODY"), "正文保留幸存者原文");
});

test("20c 未命中：文件原样不动（只做 veracity 缺省补写）", async () => {
  const fs = createMutableMemoryFs({
    [pathOf("solo.md")]: {
      content: memoryMarkdown({ body: "unique content here", name: "solo" }),
      mtimeMs: NOW - HOUR,
    },
  });
  const outcome = await enforceMemoryWriteLifecycle(
    { defaultVeracity: "extracted", fileSystem: fs.port, memoryRoot: ROOT },
    pathOf("solo.md"),
  );
  assert.equal(outcome.mergedInto, undefined);
  assert.deepEqual(outcome.duplicatesRemoved, []);
  assert.equal(outcome.veracityFilled, true, "缺 veracity 字段 → 机械补写 extracted");
  const fields = readMemoryLifecycleFields(parseMemoryFrontmatterBlock(fs.read(pathOf("solo.md"))).record);
  assert.equal(fields.veracity, "extracted");
});

test("20d MEMORY.md 不是条目：不补写、不去重、不删除", async () => {
  const fs = createMutableMemoryFs({
    [pathOf("MEMORY.md")]: { content: "- [Index](alpha.md) — hook\n", mtimeMs: NOW },
  });
  const outcome = await enforceMemoryWriteLifecycle(
    { defaultVeracity: "extracted", fileSystem: fs.port, memoryRoot: ROOT },
    pathOf("MEMORY.md"),
  );
  assert.deepEqual(outcome, { duplicatesRemoved: [], veracityFilled: false });
  assert.equal(fs.read(pathOf("MEMORY.md")), "- [Index](alpha.md) — hook\n");
});

test("20e 同批/多重复：幸存者取相对名最小者，其余既有重复不动", async () => {
  const fs = createMutableMemoryFs({
    [pathOf("a-first.md")]: {
      content: memoryMarkdown({ body: "dupe fact", name: "a" }),
      mtimeMs: NOW - 3 * HOUR,
    },
    [pathOf("b-second.md")]: {
      content: memoryMarkdown({ body: "dupe fact", name: "b" }),
      mtimeMs: NOW - 2 * HOUR,
    },
  });
  fs.write(pathOf("z-new.md"), memoryMarkdown({ body: "Dupe   FACT", name: "z" }), NOW);
  const outcome = await enforceMemoryWriteLifecycle(
    { defaultVeracity: "extracted", fileSystem: fs.port, memoryRoot: ROOT },
    pathOf("z-new.md"),
  );
  assert.equal(outcome.mergedInto, "a-first.md");
  assert.deepEqual(outcome.duplicatesRemoved, ["z-new.md"]);
  assert.equal(fs.exists(pathOf("b-second.md")), true, "其余既有重复不动（先存量后清理）");
  assert.equal(fs.exists(pathOf("a-first.md")), true);
});

test("20f importance 解析：有限数字夹紧 [0,1]，非法 → 字段不存在", () => {
  assert.equal(parseMemoryImportance(0.3), 0.3);
  assert.equal(parseMemoryImportance(5), 1);
  assert.equal(parseMemoryImportance(-2), 0);
  assert.equal(parseMemoryImportance("high"), undefined);
  assert.equal(MEMORY_IMPORTANCE_DEFAULT, 0.5);
});

test("20g frontmatter 合并规则单元：name/superseded-by 保留，其余按 R13 表", () => {
  const existing = {
    importance: 0.2,
    "superseded-by": "old-keeper",
    veracity: "tool_observed",
    name: "keeper",
    metadata: { type: "project" },
  };
  const incoming = {
    importance: 0.9,
    veracity: "unknown", // 不覆盖
    description: "fresh summary",
    name: "challenger", // 不覆盖
    "superseded-by": "sneaky", // 合并不接受新写清理失效标记
    metadata: { type: "feedback" },
  };
  const merged = mergeMemoryFrontmatterFields(existing, incoming);
  assert.equal(merged.importance, 0.9);
  assert.equal(merged.veracity, "tool_observed");
  assert.equal(merged["superseded-by"], "old-keeper");
  assert.equal(merged.name, "keeper");
  assert.equal(merged.description, "fresh summary");
  assert.equal(merged.metadata.type, "feedback", "type 写入位置跟随既有文件的 metadata 嵌套");
  // 两边都缺省 importance → 写入缺省值（合并动作本身落在盘上，字段从此存在）。
  const bothAbsent = mergeMemoryFrontmatterFields({ name: "x" }, { name: "y" });
  assert.equal(bothAbsent.importance, MEMORY_IMPORTANCE_DEFAULT);
});

test("20h frontmatter 块往返：parse/serialize 无损重组", () => {
  const content = memoryMarkdown({ body: "Fact body", name: "round", veracity: "extracted" });
  const block = parseMemoryFrontmatterBlock(content);
  assert.ok(block);
  assert.equal(block.record.name, "round");
  assert.equal(serializeMemoryFrontmatterBlock(block.record, block.body), content);
  assert.equal(parseMemoryFrontmatterBlock("no frontmatter here"), undefined);
  assert.equal(parseMemoryFrontmatterBlock("---\nnot: closed"), undefined);
});

// ── 21. Extraction 循环机械兜底（R11/R13 集成） ─────────────────────

function stubLoopModel(batches) {
  let call = 0;
  return {
    optionSpecs: { maxOutputTokens: { max: 1024 }, reasoningLevel: { values: ["low"] } },
    properties: { inputFormat: "text" },
    async generateText() {
      const batch = batches[Math.min(call, batches.length - 1)];
      call += 1;
      return { reasoning: [], text: "", toolCalls: batch ?? [] };
    },
  };
}

// 循环集成用例要过真实工具路径策略（resolveWorkspacePath 要求平台绝对路径）：
// POSIX 风格 "/store/..." 在 win32 不算绝对路径，这里用平台条件构造。
const LOOP_ROOT =
  process.platform === "win32" ? "C:/memory-root-fixture" : "/memory-root-fixture";
const LOOP_WORK = process.platform === "win32" ? "C:/work" : "/work";
const loopPathOf = (name) => `${LOOP_ROOT}/${name}`;

function runLifecycleLoop({ executeTool, files, modelBatches }) {
  const fs = createMutableMemoryFs(files);
  const promise = runMemoryAgentLoop({
    executeTool,
    maxTurns: 3,
    memoryWriteLifecycle: {
      defaultVeracity: "extracted",
      fileSystem: fs.port,
      logger: createLoggerSpy().logger,
    },
    messages: [{ content: "extract memories", role: "user" }],
    model: stubLoopModel(modelBatches),
    rootDir: LOOP_ROOT,
    tools: [
      { name: "Edit", sideEffectScope: "file" },
      { name: "Write", sideEffectScope: "file" },
    ],
    workingDirectory: LOOP_WORK,
    workspaceRoot: LOOP_WORK,
  });
  return { fs, promise };
}

test("21 Extraction 循环：Write 落盘后机械补写 veracity 缺省并去重合并", async () => {
  const duplicateContent = memoryMarkdown({
    body: "Registry mirror uses region pool",
    name: "beta-slug",
    type: "project",
    // 模型没写 veracity —— 机械兜底应补 extracted，再走去重。
  });
  let wrote = false;
  const { fs, promise } = runLifecycleLoop({
    executeTool: async (toolCall) => {
      if (toolCall.name === "Write") {
        fs.write(toolCall.input.file_path, toolCall.input.content, NOW);
        wrote = true;
      }
      return { success: true, output: {} };
    },
    files: {
      [loopPathOf("alpha.md")]: {
        content: memoryMarkdown({
          body: "registry mirror uses region pool",
          name: "alpha-slug",
          type: "project",
          veracity: "extracted",
        }),
        mtimeMs: NOW - 2 * HOUR,
      },
    },
    modelBatches: [
      [
        {
          id: "call_1",
          input: { content: duplicateContent, file_path: loopPathOf("beta.md") },
          name: "Write",
        },
      ],
      [],
    ],
  });

  const result = await promise;
  assert.equal(result.capped, false);
  assert.equal(wrote, true);
  assert.equal(fs.exists(loopPathOf("beta.md")), false, "重复文件被机械删除");
  const merged = parseMemoryFrontmatterBlock(fs.read(loopPathOf("alpha.md")));
  assert.equal(merged.record.veracity, "extracted", "合并后 veracity 为缺省档（beta 未写字段 → 兜底补写后参与合并）");
  assert.equal(merged.record.name, "alpha-slug", "幸存者是既有文件");
});

test("21b Extraction 循环：模型已写的 veracity 不被缺省覆盖", async () => {
  const { fs, promise } = runLifecycleLoop({
    executeTool: async () => ({ success: true, output: {} }),
    files: {
      [loopPathOf("fresh.md")]: {
        content: memoryMarkdown({
          body: "user insisted on bun runtime",
          name: "fresh",
          type: "user",
          veracity: "user_stated",
        }),
        mtimeMs: NOW,
      },
    },
    modelBatches: [
      [
        {
          id: "call_1",
          input: { file_path: loopPathOf("fresh.md"), new_string: "", old_string: "x" },
          name: "Edit",
        },
      ],
      [],
    ],
  });
  await promise;
  const fields = readMemoryLifecycleFields(
    parseMemoryFrontmatterBlock(fs.read(loopPathOf("fresh.md"))).record,
  );
  assert.equal(fields.veracity, "user_stated", "显式 user_stated 不被机械缺省覆盖");
});

// ── 写边指引进 prompt（R11/R12 的「谁写」决策） ──────────────────────

test("Extraction prompt 带 veracity 分档指引与 superseded-by 写边指引", () => {
  const prompt = buildMemoryExtractionPrompt({ messageCount: 10 });
  assert.match(prompt, /`veracity` frontmatter field/u);
  assert.match(prompt, /`user_stated` when the user explicitly asked/u);
  assert.match(prompt, /`tool_observed`/u);
  assert.match(prompt, /`extracted`/u);
  assert.match(prompt, /`superseded-by: <new-name>`/u);
});
