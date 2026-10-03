import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * eval runner v1 验收测试（specs/prompt-eval-runner.md 验收场景 1-5）：
 * 整形纯函数 / 报告形状与 judgeFingerprint / dist 新鲜度守护 / not-supported
 * fail-loud 与 registry 完整性 / 凭据卫生 / 红线。合成 NDJSON 驱动——测试零模型
 * 调用、零网络、零真实钥匙串/凭据触碰（验收场景 6 的 live 端到端是手动项，
 * 结果如实记录在路线图轮次记录里）。
 */

const {
  shapeTranscript,
  shapeChildTranscript,
  locateChildArtifacts,
  buildReport,
  judgeFingerprintFor,
  checkDistFreshness,
  cleanupEvalRoot,
  assertScenarioSupported,
  NOT_SUPPORTED_V1,
} = await import("../evals/runner.mjs");
const { loadScenarios } = await import("../evals/judge.mjs");

const EVALS_DIR = new URL("../evals/", import.meta.url);
const RECIPES_DIR = new URL("../evals/recipes/", import.meta.url);
const CLI_ROOT_PATH = join(new URL("..", import.meta.url).pathname.replace(/^\//, ""), "");

// 合成 NDJSON：覆盖全部保留事件 + 须丢弃的噪声 + 乱行 + 超长工具输出 + 空 assistant 消息。
const LONG_OUTPUT = "x".repeat(4000);
const SYNTHETIC_NDJSON = [
  `{"type":"turn.started","payload":{"input":"do the thing"}}`,
  `{"type":"model.streaming","payload":{"kind":"start","assistantMessageId":"m1"}}`,
  `{"type":"model.streaming","payload":{"kind":"reasoning_delta","assistantMessageId":"m1","delta":"SECRET-THINKING"}}`,
  `{"type":"model.streaming","payload":{"kind":"text_delta","assistantMessageId":"m1","delta":"Hello "}}`,
  `{"type":"model.streaming","payload":{"kind":"text_delta","assistantMessageId":"m1","delta":"world"}}`,
  `{"type":"model.streaming","payload":{"kind":"text_end","assistantMessageId":"m1"}}`,
  `{"type":"model.streaming","payload":{"kind":"tool_call","assistantMessageId":"m1","toolCallId":"c1","toolName":"Bash","input":{"command":"ls"}}}`,
  `not-json-garbage-line`,
  `{"type":"tool.updated","payload":{"toolCallId":"c1","kind":"result","result":{"success":true,"content":${JSON.stringify(LONG_OUTPUT)}},"duration":12}}`,
  `{"type":"session.updated","payload":{"anything":1}}`,
  `{"type":"model.streaming","payload":{"kind":"text_delta","assistantMessageId":"m2","delta":"   "}}`,
  `{"type":"model.streaming","payload":{"kind":"text_end","assistantMessageId":"m2"}}`,
  `{"type":"result","response":"done","sessionId":"s1"}`,
  ``,
].join("\n");

test("(场景1/R3) shapeTranscript：块序正确、噪声全弃、截断带标记、乱行跳过不崩", () => {
  const shaped = shapeTranscript(SYNTHETIC_NDJSON);
  assert.equal(shaped.eventsTotal, 12, "乱行与空行不计入事件数");
  assert.equal(shaped.blocksShaped, 5, "[user]/[assistant]/[tool call]/[tool result]/[final] 各一");
  const lines = shaped.text.split("\n");
  assert.equal(lines[0], "[user] do the thing");
  assert.ok(shaped.text.includes("[assistant] Hello world"), "text_delta 按 assistantMessageId 累积");
  assert.ok(!shaped.text.includes("SECRET-THINKING"), "reasoning delta 必须丢弃");
  assert.ok(!shaped.text.includes("session.updated") && !shaped.text.includes('"anything"'), "session.updated 丢弃");
  assert.ok(shaped.text.includes("[tool call c1] Bash"), "tool_call 带 id 与工具名");
  assert.ok(shaped.text.includes('"command": "ls"'), "输入 JSON 在场");
  assert.ok(shaped.text.includes("[tool result c1] success=true duration=12ms"));
  assert.ok(shaped.text.includes("runner-truncated 1000 chars"), "3000 字符截断带省略事实标记");
  assert.ok(!shaped.text.includes("x".repeat(3001)), "截断后超长内容不再在场");
  assert.ok(shaped.text.includes("[final assistant message] done"));
  // 纯空白的 assistant 消息不出块：
  const assistantBlocks = shaped.text.split("[assistant]").length - 1;
  assert.equal(assistantBlocks, 1);
});

test("(场景2/R4,R5) 报告形状与 judgeFingerprint：operator 披露、live 端点、pending", () => {
  assert.deepEqual(judgeFingerprintFor("operator"), { mode: "operator", model: "unspecified" });
  assert.deepEqual(judgeFingerprintFor("operator", { model: "some-model" }), { mode: "operator", model: "some-model" });
  assert.deepEqual(judgeFingerprintFor("live", { model: "judge-m", endpointHost: "h.example" }), {
    mode: "live",
    model: "judge-m",
    endpointHost: "h.example",
  });
  assert.deepEqual(judgeFingerprintFor("pending"), { mode: "pending" });

  const report = buildReport({
    scenarioId: "s-id",
    runId: "20261004T000000Z",
    status: "scored",
    judgeFingerprint: judgeFingerprintFor("operator", { model: "m" }),
    collection: { wallMs: 5 },
    score: { pass: true, passRate: 1 },
  });
  assert.equal(report.spec, "apps/acode-cli/specs/prompt-eval-runner.md");
  assert.equal(report.scenarioId, "s-id");
  assert.equal(report.status, "scored");
  assert.equal(report.judgeFingerprint.mode, "operator");
  assert.equal(report.collection.wallMs, 5);
  assert.equal(report.pass, true, "score 字段并入报告顶层");
});

test("(场景2/R2) dist 新鲜度守护：陈旧 fail-loud 并给出重建命令，新鲜放行", () => {
  const stale = checkDistFreshness(1000, 2000);
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /turbo run build/);
  assert.equal(checkDistFreshness(2000, 1000).ok, true);
  assert.equal(checkDistFreshness(2000, 2000).ok, true);
});

test("(场景1/R3) shapeChildTranscript：末行 messages 全链映射 + final report 追加 + 截断标记", () => {
  const older = JSON.stringify({ request: { body: { messages: [{ role: "user", content: "stale prefix" }] } } });
  const lastLine = JSON.stringify({
    request: {
      body: {
        messages: [
          { role: "user", content: "do the child task" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "I will search." },
              { type: "tool_use", id: "tu1", name: "Bash", input: { command: "grep -r QuantumFlux ." } },
            ],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "y".repeat(4000) }] },
          { role: "assistant", content: [{ type: "text", text: "Nothing found." }] },
        ],
      },
    },
  });
  const shaped = shapeChildTranscript(`${older}\n${lastLine}\n`, "## Negative result\nnothing here");
  assert.ok(shaped.text.includes("[user] do the child task"), "末行消息链为准（stale prefix 不出现）");
  assert.ok(!shaped.text.includes("stale prefix"));
  assert.ok(shaped.text.includes("[assistant] I will search."));
  assert.ok(shaped.text.includes("[tool call tu1] Bash"));
  assert.ok(shaped.text.includes("[tool result tu1]"));
  assert.ok(shaped.text.includes("runner-truncated 1000 chars"), "子转录同截断规则");
  assert.ok(shaped.text.includes("[assistant] Nothing found."));
  assert.ok(shaped.text.endsWith("[final report] ## Negative result\nnothing here\n"), "output.txt 全文收尾");
});

test("(场景1/R6) locateChildArtifacts：metadata 映射 childSessionId；空/缺目录返回 []", () => {
  const root = mkdtempSync(join(tmpdir(), "acode-runner-child-"));
  try {
    const parent = "sess_parent1";
    const agentDir = join(root, "cli", "agents", parent, "agent_a1");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(root, "cli", "rollout"), { recursive: true });
    writeFileSync(
      join(agentDir, "metadata.json"),
      JSON.stringify({ agentId: "agent_a1", childSessionId: "sess_subagent_agent_a1", description: "find X" }),
      "utf-8",
    );
    writeFileSync(join(root, "cli", "rollout", "model-io-sess_subagent_agent_a1.jsonl"), "{}\n", "utf-8");
    writeFileSync(join(agentDir, "output.txt"), "report body", "utf-8");
    const found = locateChildArtifacts(root, parent);
    assert.equal(found.length, 1);
    assert.equal(found[0].description, "find X");
    assert.ok(found[0].modelIoPath.endsWith("model-io-sess_subagent_agent_a1.jsonl"));
    assert.ok(found[0].reportPath.endsWith("output.txt"));
    assert.deepEqual(locateChildArtifacts(root, "sess_missing"), []);
    assert.deepEqual(locateChildArtifacts(join(root, "nope"), parent), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("(场景3/R6) not-supported-v1 登记 fail-loud 指向 §R7（仅剩 restart-orphan）；registry 无静默缺口", async () => {
  assert.deepEqual(Object.keys(NOT_SUPPORTED_V1), ["restart-orphan-handling"], "EXP1/EXP2 关闭后仅剩重启编排");
  for (const id of Object.keys(NOT_SUPPORTED_V1)) {
    assert.throws(
      () => assertScenarioSupported(id),
      (error) => error.message.includes("not-supported-v1") && error.message.includes("prompt-eval-runner.md"),
      `${id} 必须显式报错并指向 spec`,
    );
  }
  assertScenarioSupported("self-verification-before-done"); // 支持面不误伤
  assertScenarioSupported("explore-empty-result-honesty"); // EXP1 后已转 ready

  const scenarios = await loadScenarios();
  const ids = scenarios.map((s) => s.id);
  const recipeIds = readdirSync(RECIPES_DIR).filter((f) => f.endsWith(".mjs")).map((f) => f.replace(/\.mjs$/, ""));
  // 12 场景 = recipe ∪ not-supported，两集合不相交、无第三态（缺口即静默跳过，禁止）。
  for (const id of ids) {
    assert.ok(recipeIds.includes(id) || id in NOT_SUPPORTED_V1, `${id} 既无 recipe 也未登记 not-supported`);
    assert.ok(!(recipeIds.includes(id) && id in NOT_SUPPORTED_V1), `${id} 同时出现在两个登记面`);
  }
  for (const id of Object.keys(NOT_SUPPORTED_V1)) {
    assert.ok(ids.includes(id), `not-supported 登记了不存在的场景 ${id}`);
  }
  // recipe 导出面合法：
  const scenarioById = new Map(scenarios.map((s) => [s.id, s]));
  for (const id of recipeIds) {
    const recipe = await import(new URL(`./${id}.mjs`, RECIPES_DIR).href);
    assert.equal(typeof recipe.setup, "function", `${id} 必须导出 setup(dir)`);
    assert.ok(
      recipe.mode === undefined || ["build", "plan", "edit", "yolo", "auto"].includes(recipe.mode),
      `${id} mode 非法: ${recipe.mode}`,
    );
    assert.ok(recipe.experimental === undefined || recipe.experimental === true, `${id} experimental 必须是 true/缺省`);
    assert.ok(recipe.judgeTarget === undefined || recipe.judgeTarget === "child", `${id} judgeTarget 必须是 "child"/缺省`);
    // 舞台指示 prompt 的场景必须声明父侧投递语（runner 据此投递，缺声明 fail-loud）：
    if (scenarioById.get(id).prompt.startsWith("(")) {
      assert.equal(typeof recipe.parentPrompt, "string", `${id} 语料 prompt 是舞台指示，recipe 必须声明 parentPrompt`);
      assert.ok(!recipe.parentPrompt.startsWith("("), `${id} parentPrompt 自身不得是舞台指示`);
    }
  }
});

test("(场景4/R2) 凭据卫生：keepRoot 只删凭据副本，缺省删整个 eval 根", () => {
  const root = mkdtempSync(join(tmpdir(), "acode-runner-hygiene-"));
  const v2 = join(root, "data-base", ".acode", "v2");
  mkdirSync(v2, { recursive: true });
  mkdirSync(join(root, "storage"), { recursive: true });
  for (const name of ["credentials.json", "credential-key.json", "credential-key.dpapi.json", "provider_config.json"]) {
    writeFileSync(join(v2, name), "{}", "utf-8");
  }
  cleanupEvalRoot(root, { keepRoot: true });
  assert.ok(existsSync(root), "keepRoot 保留目录供复用");
  assert.ok(!existsSync(join(v2, "credentials.json")), "凭据副本必须删除");
  assert.ok(!existsSync(join(v2, "credential-key.json")), "密钥材料必须删除");
  assert.ok(!existsSync(join(v2, "credential-key.dpapi.json")), "DPAPI blob 必须删除");
  assert.ok(existsSync(join(v2, "provider_config.json")), "非凭据配置可保留（复用调试面）");

  cleanupEvalRoot(root, { keepRoot: false });
  assert.ok(!existsSync(root), "缺省删除整个 eval 根");
});

test("(场景5/红线) runner/recipes 无 ACODE_ env 读取（数据根两个写键白名单）；产品运行时零引用 evals/", () => {
  const runnerSource = readFileSync(new URL("../evals/runner.mjs", EVALS_DIR), "utf-8");
  assert.ok(!runnerSource.includes("process.env.ACODE_"), "runner 不得读取任何 ACODE_ env");
  const acodeLiterals = [...new Set(runnerSource.match(/ACODE_[A-Z_]+/g) ?? [])];
  assert.deepEqual(
    acodeLiterals.sort(),
    ["ACODE_DATA_BASE_DIR", "ACODE_STORAGE_DIR"],
    "ACODE_ 字面量白名单 = 数据根两个写键（spec 红线）",
  );
  for (const file of readdirSync(RECIPES_DIR)) {
    const source = readFileSync(new URL(`./${file}`, RECIPES_DIR), "utf-8");
    assert.ok(!source.includes("ACODE_"), `recipe ${file} 不得出现 ACODE_ env`);
  }
  // 产品运行时（packages/*/src）零处引用 evals/（承接 v0 场景 6 同一断言）：
  let hits = "";
  try {
    hits = execFileSync("grep", ["-rl", "--include=*.ts", "evals/", "packages"], {
      cwd: CLI_ROOT_PATH,
      encoding: "utf8",
    });
  } catch {
    hits = ""; // grep 无命中时退出码 1
  }
  assert.equal(hits.trim(), "", `产品运行时源码不得引用 evals/：${hits}`);
});
