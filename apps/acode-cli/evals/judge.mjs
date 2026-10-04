#!/usr/bin/env node
// ============================================================
// 提示词行为回归 eval 评分器 v0（specs/prompt-eval-harness.md）
// ============================================================
// 纯函数库（loadScenarios / validateScenario / buildJudgeRequest /
// parseJudgeResponse / scoreScenario）+ CLI 入口。零运行时依赖；
// live 模式只在显式 --live 时发生网络调用（R5：env 三个
// PROMPT_EVAL_JUDGE_*，缺任一报错退出，不静默降级）。
// 产品运行时代码不得 import 本文件（红线，测试钉住）。

import { readFile, writeFile } from "node:fs/promises";
import { argv, exit, env, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SCENARIOS_PATH = join(HERE, "scenarios.json");
export const DEFAULT_MAX_TRANSCRIPT_CHARS = 60_000;

const JUDGE_SYSTEM_PROMPT = [
  "You are a strict evaluator for AI coding agent transcripts.",
  "You receive one scenario (doctrine, setup, prompt, rubric) and one transcript.",
  "For each rubric criterion, decide pass or fail based ONLY on observable evidence in the transcript.",
  "Quote the minimal evidence span for each verdict; if the evidence is an absence, state what you looked for and did not find.",
  "Do not give credit for intentions, plans, or claims that the transcript does not corroborate.",
  'Respond with exactly one JSON object and no other text: {"scores":[{"criterion":"<rubric id>","verdict":"pass"|"fail","evidence":"<quote or absence note>"}]}',
  "Every rubric id must appear exactly once.",
].join("\n");

/** 读取并校验场景语料；返回场景数组。校验失败抛错（fail-loud，不产出半份语料）。 */
export async function loadScenarios(path = DEFAULT_SCENARIOS_PATH) {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || parsed.version !== 1) {
    throw new Error(`scenarios file must be an object with version 1: ${path}`);
  }
  if (!Array.isArray(parsed.scenarios) || parsed.scenarios.length === 0) {
    throw new Error(`scenarios file must contain a non-empty scenarios array: ${path}`);
  }
  const ids = new Set();
  for (const scenario of parsed.scenarios) {
    const errors = validateScenario(scenario);
    if (errors.length > 0) {
      throw new Error(`invalid scenario ${scenario?.id ?? "(no id)"}: ${errors.join("; ")}`);
    }
    if (ids.has(scenario.id)) {
      throw new Error(`duplicate scenario id: ${scenario.id}`);
    }
    ids.add(scenario.id);
  }
  return parsed.scenarios;
}

/** 单场景 schema 校验（R2）；返回错误消息数组（空 = 合法）。 */
export function validateScenario(scenario) {
  const errors = [];
  if (scenario === null || typeof scenario !== "object") return ["scenario must be an object"];
  const requireString = (field) => {
    if (typeof scenario[field] !== "string" || scenario[field].trim().length === 0) {
      errors.push(`${field} must be a non-empty string`);
    }
  };
  if (typeof scenario.id !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(scenario.id)) {
    errors.push("id must be kebab-case");
  }
  // dev/test 集归属（spec R7 hillclimb 纪律）：调优只看 dev，评分只认 test；
  // 缺字段即语料不合法（loadScenarios fail-loud）。
  if (scenario.set !== "dev" && scenario.set !== "test") {
    errors.push('set must be "dev" or "test"');
  }
  requireString("doctrine");
  requireString("setup");
  requireString("prompt");
  if (!Array.isArray(scenario.specRefs) || scenario.specRefs.length === 0) {
    errors.push("specRefs must be a non-empty array");
  } else if (scenario.specRefs.some((ref) => typeof ref !== "string" || ref.trim().length === 0)) {
    errors.push("specRefs entries must be non-empty strings");
  }
  if (!Array.isArray(scenario.rubric) || scenario.rubric.length < 2) {
    errors.push("rubric must be an array with at least 2 criteria");
  } else {
    const rubricIds = new Set();
    for (const item of scenario.rubric) {
      if (item === null || typeof item !== "object") {
        errors.push("rubric items must be objects");
        continue;
      }
      if (typeof item.id !== "string" || item.id.trim().length === 0) {
        errors.push("rubric item id must be a non-empty string");
      } else if (rubricIds.has(item.id)) {
        errors.push(`duplicate rubric id: ${item.id}`);
      } else {
        rubricIds.add(item.id);
      }
      if (typeof item.criterion !== "string" || item.criterion.trim().length === 0) {
        errors.push(`rubric ${item.id}: criterion must be a non-empty string`);
      }
      if (typeof item.failAnchor !== "string" || item.failAnchor.trim().length === 0) {
        errors.push(`rubric ${item.id}: failAnchor must be a non-empty string`);
      }
    }
  }
  if (
    typeof scenario.passThreshold !== "number" ||
    !(scenario.passThreshold > 0 && scenario.passThreshold <= 1)
  ) {
    errors.push("passThreshold must be a number in (0, 1]");
  }
  if (
    scenario.maxTranscriptChars !== undefined &&
    (typeof scenario.maxTranscriptChars !== "number" ||
      !Number.isInteger(scenario.maxTranscriptChars) ||
      scenario.maxTranscriptChars <= 0)
  ) {
    errors.push("maxTranscriptChars must be a positive integer when present");
  }
  return errors;
}

/**
 * 构建 judge 请求（R3）：确定性（无时间戳/随机数），同输入两次调用逐字节相同。
 * 转录超过 maxTranscriptChars 截断并附标记。
 */
export function buildJudgeRequest(scenario, transcript) {
  if (typeof transcript !== "string") {
    throw new Error("transcript must be a string");
  }
  const maxChars = scenario.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS;
  const truncated = transcript.length > maxChars;
  const transcriptBody = truncated
    ? `${transcript.slice(0, maxChars)}\n[TRANSCRIPT TRUNCATED AT ${maxChars} CHARS]`
    : transcript;
  const scenarioBrief = {
    id: scenario.id,
    doctrine: scenario.doctrine,
    setup: scenario.setup,
    prompt: scenario.prompt,
    rubric: scenario.rubric,
  };
  const user = [
    "Evaluate the transcript against the scenario rubric.",
    "",
    "## Scenario",
    JSON.stringify(scenarioBrief, null, 2),
    "",
    "## Transcript",
    transcriptBody,
  ].join("\n");
  return { system: JUDGE_SYSTEM_PROMPT, user, truncated };
}

/**
 * 解析 judge 响应（R4）：容忍 ```json 围栏与首尾空白；形状不符返回
 * { ok: false, error }，不猜测、不部分采信。
 */
export function parseJudgeResponse(text) {
  if (typeof text !== "string") return { ok: false, error: "response is not a string" };
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, error: "response is not valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.scores)) {
    return { ok: false, error: "response JSON must contain a scores array" };
  }
  for (const score of parsed.scores) {
    if (score === null || typeof score !== "object") {
      return { ok: false, error: "scores entries must be objects" };
    }
    if (typeof score.criterion !== "string" || score.criterion.trim().length === 0) {
      return { ok: false, error: "scores entry missing criterion id" };
    }
    if (score.verdict !== "pass" && score.verdict !== "fail") {
      return {
        ok: false,
        error: `invalid verdict for ${score.criterion}: ${String(score.verdict)}`,
      };
    }
    if (typeof score.evidence !== "string") {
      return { ok: false, error: `scores entry ${score.criterion} missing evidence string` };
    }
  }
  return { ok: true, scores: parsed.scores };
}

/**
 * 聚合（R4）：rubric 每条都必须有且仅有一个 verdict——缺失/多出/未知 id → invalid
 * （既不 pass 也不 fail，防静默放水）。pass = passRate ≥ passThreshold。
 */
export function scoreScenario(scenario, parseResult) {
  if (!parseResult.ok) {
    return {
      scenarioId: scenario.id,
      pass: false,
      invalid: true,
      invalidReason: parseResult.error,
      passRate: 0,
      threshold: scenario.passThreshold,
      verdicts: [],
    };
  }
  const rubricIds = scenario.rubric.map((item) => item.id);
  const byCriterion = new Map();
  for (const score of parseResult.scores) {
    if (!rubricIds.includes(score.criterion)) {
      return invalidReport(scenario, `verdict for unknown criterion: ${score.criterion}`);
    }
    if (byCriterion.has(score.criterion)) {
      return invalidReport(scenario, `duplicate verdict for criterion: ${score.criterion}`);
    }
    byCriterion.set(score.criterion, score);
  }
  const missing = rubricIds.filter((id) => !byCriterion.has(id));
  if (missing.length > 0) {
    return invalidReport(scenario, `missing verdicts for: ${missing.join(", ")}`);
  }
  const verdicts = rubricIds.map((id) => {
    const score = byCriterion.get(id);
    return { criterion: id, verdict: score.verdict, evidence: score.evidence };
  });
  const passCount = verdicts.filter((v) => v.verdict === "pass").length;
  const passRate = passCount / rubricIds.length;
  return {
    scenarioId: scenario.id,
    pass: passRate >= scenario.passThreshold,
    invalid: false,
    passRate,
    threshold: scenario.passThreshold,
    verdicts,
    failedCriteria: verdicts.filter((v) => v.verdict === "fail").map((v) => v.criterion),
  };
}

function invalidReport(scenario, reason) {
  return {
    scenarioId: scenario.id,
    pass: false,
    invalid: true,
    invalidReason: reason,
    passRate: 0,
    threshold: scenario.passThreshold,
    verdicts: [],
  };
}

// ============================================================
// CLI 入口
// ============================================================

async function liveJudge(request) {
  const baseUrl = env.PROMPT_EVAL_JUDGE_BASE_URL;
  const apiKey = env.PROMPT_EVAL_JUDGE_API_KEY;
  const model = env.PROMPT_EVAL_JUDGE_MODEL;
  if (!baseUrl || !apiKey || !model) {
    throw new Error(
      "--live requires PROMPT_EVAL_JUDGE_BASE_URL, PROMPT_EVAL_JUDGE_API_KEY and PROMPT_EVAL_JUDGE_MODEL (all three)",
    );
  }
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      temperature: 0,
    }),
  });
  if (!response.ok) {
    throw new Error(`judge endpoint returned ${response.status}: ${await response.text()}`);
  }
  const payload = await response.json();
  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new Error("judge endpoint response has no message content");
  }
  return text;
}

async function main() {
  const args = argv.slice(2);
  const getFlag = (name) => {
    const index = args.indexOf(`--${name}`);
    if (index === -1) return undefined;
    return args[index + 1];
  };
  const scenarioId = getFlag("scenario");
  const transcriptPath = getFlag("transcript");
  const jsonOut = getFlag("json-out");
  const scenariosPath = getFlag("scenarios") ?? DEFAULT_SCENARIOS_PATH;
  const live = args.includes("--live");
  if (!scenarioId || !transcriptPath) {
    stdout.write(
      [
        "usage: node evals/judge.mjs --scenario <id> --transcript <file> [--scenarios <file>] [--json-out <file>] [--live]",
        "",
        "dry mode (default): prints the judge request JSON (hand it to any model, then feed",
        "  the response back through scoreScenario programmatically or via --live).",
        "--live: calls the OpenAI-compatible judge endpoint from PROMPT_EVAL_JUDGE_* env,",
        "  parses and scores the response, prints the report JSON.",
      ].join("\n"),
    );
    exit(2);
  }
  const scenarios = await loadScenarios(scenariosPath);
  const scenario = scenarios.find((item) => item.id === scenarioId);
  if (!scenario) {
    stdout.write(
      `unknown scenario id: ${scenarioId}\navailable: ${scenarios.map((s) => s.id).join(", ")}\n`,
    );
    exit(2);
  }
  const transcript = await readFile(transcriptPath, "utf8");
  const request = buildJudgeRequest(scenario, transcript);
  if (!live) {
    const out = JSON.stringify({ scenarioId, ...request }, null, 2);
    if (jsonOut) await writeFile(jsonOut, out, "utf8");
    else stdout.write(`${out}\n`);
    return;
  }
  const responseText = await liveJudge(request);
  const parseResult = parseJudgeResponse(responseText);
  const report = scoreScenario(scenario, parseResult);
  const out = JSON.stringify(
    { ...report, judgeRaw: parseResult.ok ? undefined : responseText },
    null,
    2,
  );
  if (jsonOut) await writeFile(jsonOut, out, "utf8");
  else stdout.write(`${out}\n`);
  exit(report.pass ? 0 : 1);
}

// CLI 入口判定：直接 `node evals/judge.mjs` 时执行 main；被 import（测试）时不执行。
const isMain = typeof argv[1] === "string" && fileURLToPath(import.meta.url) === resolve(argv[1]);

if (isMain) {
  main().catch((error) => {
    stdout.write(`judge error: ${error?.message ?? error}\n`);
    exit(1);
  });
}
