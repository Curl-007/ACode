import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";

/**
 * W8 验收测试：提示词行为回归 eval 脚手架 v0。
 *
 * 覆盖规格 apps/acode-cli/specs/prompt-eval-harness.md 的 R1–R6 与验收场景 1–6：
 * - 场景 1：语料 schema（12 场景、id 唯一、rubric ≥2、threshold ∈ (0,1]、specRefs 文件存在）；
 * - 场景 2：judge 请求构建（rubric/转录在场、确定性、截断标记）；
 * - 场景 3：响应解析（合法/围栏/散文包裹 → ok；形状不符 → {ok:false}）；
 * - 场景 4：聚合（全 pass / 单 fail@threshold=1 / verdict 缺失 → invalid）；
 * - 场景 5：fixture 端到端；
 * - 场景 6：红线（evals 无 ACODE_ env；产品运行时源码不引用 evals/）。
 */

const {
  loadScenarios,
  validateScenario,
  buildJudgeRequest,
  parseJudgeResponse,
  scoreScenario,
  DEFAULT_SCENARIOS_PATH,
} = await import("../evals/judge.mjs");

const FIXTURE_PATH = new URL("../evals/fixtures/judge-response-sample.json", import.meta.url);
const REPO_ROOT = new URL("../../../", import.meta.url);

const scenarios = await loadScenarios(DEFAULT_SCENARIOS_PATH);
const relayScenario = scenarios.find((s) => s.id === "relay-verification");
const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));

test("(场景1/R2,R6) 语料 schema：12 场景、覆盖表齐全、specRefs 指向存在的文件", async () => {
  assert.equal(scenarios.length, 12);
  const ids = scenarios.map((s) => s.id);
  assert.equal(new Set(ids).size, 12);
  // R6 覆盖表逐 id 在场：
  for (const expected of [
    "dispatch-prompt-self-contained",
    "continue-vs-spawn-choice",
    "relay-verification",
    "permission-gate-posture",
    "background-no-polling",
    "subagent-report-structure",
    "subagent-scope-discipline",
    "subagent-denial-single-report",
    "explore-empty-result-honesty",
    "self-verification-before-done",
    "web-content-untrusted",
    "restart-orphan-handling",
  ]) {
    assert.ok(ids.includes(expected), `missing scenario: ${expected}`);
  }
  for (const scenario of scenarios) {
    assert.deepEqual(validateScenario(scenario), [], scenario.id);
    assert.ok(scenario.rubric.length >= 2, scenario.id);
    assert.ok(scenario.passThreshold > 0 && scenario.passThreshold <= 1, scenario.id);
    for (const ref of scenario.specRefs) {
      const refPath = ref.split("#")[0];
      await access(join(REPO_ROOT.pathname.replace(/^\//, ""), refPath));
    }
    // rubric criterion 禁条件式措辞（R2）：不以 if/when 开头的假设句形态粗查
    for (const item of scenario.rubric) {
      assert.ok(item.criterion.length > 20, `${scenario.id}/${item.id} criterion 过短`);
    }
  }
});

test("(场景1) validateScenario 拒绝坏形状", () => {
  assert.ok(validateScenario(null).length > 0);
  assert.ok(validateScenario({ ...relayScenario, id: "NotKebab" }).length > 0);
  assert.ok(validateScenario({ ...relayScenario, rubric: relayScenario.rubric.slice(0, 1) }).length > 0);
  assert.ok(validateScenario({ ...relayScenario, passThreshold: 0 }).length > 0);
  assert.ok(validateScenario({ ...relayScenario, passThreshold: 1.5 }).length > 0);
  assert.ok(validateScenario({ ...relayScenario, specRefs: [] }).length > 0);
  assert.ok(validateScenario({ ...relayScenario, maxTranscriptChars: -1 }).length > 0);
});

test("(场景2/R3) judge 请求构建：要素在场、确定性、截断标记", () => {
  const transcript = "user: fix it\nassistant: done";
  const request = buildJudgeRequest(relayScenario, transcript);
  assert.ok(request.system.includes("strict evaluator"));
  assert.ok(request.user.includes('"id": "relay-verification"'));
  for (const item of relayScenario.rubric) {
    assert.ok(request.user.includes(item.criterion), `rubric missing in request: ${item.id}`);
  }
  assert.ok(request.user.includes(transcript));
  assert.equal(request.truncated, false);
  // 确定性：
  assert.deepEqual(buildJudgeRequest(relayScenario, transcript), request);
  // 截断：
  const long = "x".repeat(relayScenario.maxTranscriptChars + 100);
  const truncatedRequest = buildJudgeRequest(relayScenario, long);
  assert.equal(truncatedRequest.truncated, true);
  assert.ok(
    truncatedRequest.user.includes(`[TRANSCRIPT TRUNCATED AT ${relayScenario.maxTranscriptChars} CHARS]`),
  );
  assert.ok(!truncatedRequest.user.includes("x".repeat(relayScenario.maxTranscriptChars + 1)));
});

test("(场景3/R4) 响应解析：合法/围栏/散文包裹 → ok；坏形状 → {ok:false}", () => {
  assert.equal(parseJudgeResponse(JSON.stringify(fixture.passShape)).ok, true);
  assert.equal(parseJudgeResponse(fixture.fencedShape).ok, true);
  assert.equal(
    parseJudgeResponse(`  ${JSON.stringify(fixture.passShape)}  `).ok,
    true,
  );
  assert.equal(parseJudgeResponse("not json at all").ok, false);
  assert.equal(parseJudgeResponse('{"verdicts":[]}').ok, false); // 缺 scores
  assert.equal(
    parseJudgeResponse(
      JSON.stringify({ scores: [{ criterion: "evidence-check", verdict: "maybe", evidence: "x" }] }),
    ).ok,
    false,
  ); // verdict 非法
  assert.equal(
    parseJudgeResponse(JSON.stringify({ scores: [{ criterion: "evidence-check", verdict: "pass" }] }))
      .ok,
    false,
  ); // 缺 evidence
  assert.equal(parseJudgeResponse(42).ok, false);
});

test("(场景4/R4) 聚合：全 pass / 单 fail / verdict 缺失或越界 → invalid", () => {
  const passResult = scoreScenario(relayScenario, parseJudgeResponse(JSON.stringify(fixture.passShape)));
  assert.equal(passResult.pass, true);
  assert.equal(passResult.invalid, false);
  assert.equal(passResult.passRate, 1);
  assert.equal(passResult.verdicts.length, 2);

  const failResult = scoreScenario(relayScenario, parseJudgeResponse(JSON.stringify(fixture.failShape)));
  assert.equal(failResult.pass, false); // threshold = 1.0，单 fail 即挂
  assert.equal(failResult.invalid, false);
  assert.deepEqual(failResult.failedCriteria, ["evidence-check"]);

  const missing = scoreScenario(
    relayScenario,
    parseJudgeResponse(JSON.stringify(fixture.missingVerdictShape)),
  );
  assert.equal(missing.invalid, true);
  assert.equal(missing.pass, false);
  assert.ok(missing.invalidReason.includes("missing verdicts"));

  const unknown = scoreScenario(
    relayScenario,
    parseJudgeResponse(
      JSON.stringify({
        scores: [
          { criterion: "evidence-check", verdict: "pass", evidence: "a" },
          { criterion: "claims-match-evidence", verdict: "pass", evidence: "b" },
          { criterion: "not-in-rubric", verdict: "pass", evidence: "c" },
        ],
      }),
    ),
  );
  assert.equal(unknown.invalid, true);
  assert.ok(unknown.invalidReason.includes("unknown criterion"));

  const brokenParse = scoreScenario(relayScenario, { ok: false, error: "response is not valid JSON" });
  assert.equal(brokenParse.invalid, true);
  assert.equal(brokenParse.pass, false);
});

test("(场景5) fixture 端到端：fenced 响应 → parse → score 报告形状完整", () => {
  const parsed = parseJudgeResponse(fixture.fencedShape);
  assert.equal(parsed.ok, true);
  const report = scoreScenario(relayScenario, parsed);
  assert.deepEqual(
    { ...report, verdicts: undefined, failedCriteria: undefined },
    {
      scenarioId: "relay-verification",
      pass: true,
      invalid: false,
      passRate: 1,
      threshold: 1,
      verdicts: undefined,
      failedCriteria: undefined,
    },
  );
  assert.deepEqual(report.verdicts.map((v) => v.criterion), ["evidence-check", "claims-match-evidence"]);
});

test("(场景6/红线) evals 无 ACODE_ env；产品运行时源码不引用 evals/", async () => {
  const judgeSource = await readFile(new URL("../evals/judge.mjs", import.meta.url), "utf8");
  assert.ok(!judgeSource.includes("ACODE_"), "judge.mjs 不得读取 ACODE_ 前缀 env（dev 脚本面独立命名）");
  assert.ok(judgeSource.includes("PROMPT_EVAL_JUDGE_BASE_URL"));
  // 产品运行时（packages/*/src）零处引用 evals/：
  const { execFileSync } = await import("node:child_process");
  let hits = "";
  try {
    hits = execFileSync(
      "grep",
      ["-rl", "--include=*.ts", "evals/", "packages"],
      { cwd: new URL("..", import.meta.url).pathname.replace(/^\//, ""), encoding: "utf8" },
    );
  } catch {
    hits = ""; // grep 无命中时退出码 1
  }
  assert.equal(hits.trim(), "", `产品运行时源码不得引用 evals/：${hits}`);
});
