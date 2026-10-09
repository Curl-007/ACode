#!/usr/bin/env node
/**
 * eval runner v1（specs/prompt-eval-runner.md）：采集/整形/判分编排。
 *
 * 用法（apps/acode-cli 目录）：
 *   node evals/runner.mjs --scenario <id> [--judge dry|response] [--eval-root <dir>]
 *                         [--run <runId>] [--judge-model <id>]
 *
 * - `--judge dry`（缺省）：布置隔离环境 → 无头采集 → 整形 → 生成 judge 请求；
 *   `PROMPT_EVAL_JUDGE_*` 三件套齐备时直接经 judge.mjs --live 判分（不复制网络代码）。
 * - `--judge response`：读回 reports/raw/<runId>/response.json（操作员/外部模型对
 *   dry 请求的响应）→ judge.mjs 纯函数判分 → 终态报告。
 *
 * 红线（spec 头部）：no-telemetry（产品运行时零消费本目录）；转录/request/response
 * 只落 reports/raw/（gitignored，永不入库）；每份报告带 judgeFingerprint，指纹不同
 * 不得互算 delta。凭据卫生：eval 根的凭据副本在**所有路径**（含失败）下清理。
 */
import { execSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { buildJudgeRequest, loadScenarios, parseJudgeResponse, scoreScenario } from "./judge.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(HERE, "..");
const CLI_DIST = join(CLI_ROOT, "packages/cli/dist/acode.cjs");
const CLI_SRC_PACKAGES = ["core", "contracts", "bootstrap", "cli"];
const REAL_V2_DIR = join(homedir(), ".acode", "v2");
const REPORTS_DIR = join(HERE, "reports");
const RAW_DIR = join(REPORTS_DIR, "raw");
import {
  SPEC_REF,
  checkDistFreshness,
  judgeFingerprintFor,
  buildReport,
} from "./runner-report.mjs";
export { checkDistFreshness, judgeFingerprintFor, buildReport } from "./runner-report.mjs";

/** 数据根两个 env 是白名单全集（红线：runner 不新增 ACODE_ 开关面）。 */
const ENV_STORAGE = "ACODE_STORAGE_DIR";
const ENV_DATA_BASE = "ACODE_DATA_BASE_DIR";

/** §R6 not-supported-v1 登记：显式报错指向 open questions，绝不静默跳过。 */
export const NOT_SUPPORTED_V1 = {
  "restart-orphan-handling": "§R7-6 kill+resume 编排未验证",
};

import { shapeTranscript, shapeChildTranscript } from "./runner-transcript.mjs";
export { shapeTranscript, shapeChildTranscript } from "./runner-transcript.mjs";

/**
 * 子代理工件定位（EXP1 实证）：`cli/agents/<parentSess>/agent_<id>/metadata.json` 给
 * childSessionId 映射；rollout model-io 与 output.txt 按命名约定取。多子代理时调用方
 * fail-loud（v1 语料均为单子代理场景，多选语义不猜）。
 */
export function locateChildArtifacts(storageRoot, parentSessionId) {
  const agentsRoot = join(storageRoot, "cli", "agents", parentSessionId);
  if (!existsSync(agentsRoot)) return [];
  const found = [];
  for (const agentDir of readdirSync(agentsRoot)) {
    const metaPath = join(agentsRoot, agentDir, "metadata.json");
    if (!existsSync(metaPath)) continue;
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    if (!meta.childSessionId) continue;
    found.push({
      description: meta.description ?? "",
      modelIoPath: join(storageRoot, "cli", "rollout", `model-io-${meta.childSessionId}.jsonl`),
      reportPath: join(agentsRoot, agentDir, "output.txt"),
    });
  }
  return found;
}

function latestSrcMtimeMs() {
  let latest = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else latest = Math.max(latest, statSync(full).mtimeMs);
    }
  };
  for (const pkg of CLI_SRC_PACKAGES) {
    const src = join(CLI_ROOT, "packages", pkg, "src");
    if (existsSync(src)) walk(src);
  }
  return latest;
}

/**
 * 凭据卫生（spec §R2）：删除 eval 根里的凭据副本。keepRoot=false（缺省，mkdtemp
 * 根）删整个根；keepRoot=true（--eval-root 复用）只删凭据与密钥材料。
 * 所有路径（含采集失败）都必须经过这里。
 */
export function cleanupEvalRoot(evalRoot, { keepRoot = false } = {}) {
  if (!keepRoot) {
    rmSync(evalRoot, { recursive: true, force: true });
    return;
  }
  const v2 = join(evalRoot, "data-base", ".acode", "v2");
  for (const name of ["credentials.json", "credential-key.json", "credential-key.dpapi.json"]) {
    rmSync(join(v2, name), { force: true });
  }
}

export function assertScenarioSupported(scenarioId) {
  const blocked = NOT_SUPPORTED_V1[scenarioId];
  if (blocked) {
    throw new Error(
      `scenario "${scenarioId}" is not-supported-v1: ${blocked}（见 ${SPEC_REF} §R7）`,
    );
  }
}

async function loadRecipe(scenarioId) {
  assertScenarioSupported(scenarioId);
  try {
    return await import(pathToFileURL(join(HERE, "recipes", `${scenarioId}.mjs`)).href);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      throw new Error(
        `no recipe for scenario "${scenarioId}"（recipes/${scenarioId}.mjs 缺席 = not-supported，见 ${SPEC_REF} §R6）`,
      );
    }
    throw error;
  }
}

function newRunId(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
}

function recipeDigest(scenarioId) {
  const file = join(HERE, "recipes", `${scenarioId}.mjs`);
  return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);
}

function runChild(command, args, { cwd, env, stdoutFile, stderrFile, timeoutMs }) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, env });
    const outChunks = [];
    const errChunks = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => outChunks.push(chunk));
    child.stderr.on("data", (chunk) => errChunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(stdoutFile, Buffer.concat(outChunks));
      writeFileSync(stderrFile, Buffer.concat(errChunks));
      resolveRun({ code });
    });
  });
}

function currentCommit() {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: CLI_ROOT, encoding: "utf-8" }).trim();
  } catch {
    return "unknown"; // 非 git 检出（发布产物内跑 dev 脚本）不阻断采集，如实标注
  }
}

function latestRawRunDir(scenarioId) {
  if (!existsSync(RAW_DIR)) return undefined;
  const matches = readdirSync(RAW_DIR)
    .filter((name) => name.startsWith(`${scenarioId}-`))
    .sort();
  return matches.length ? join(RAW_DIR, matches[matches.length - 1]) : undefined;
}

async function judgeResponseFlow(scenario, runDirArg) {
  const runDir = runDirArg ? join(RAW_DIR, runDirArg) : latestRawRunDir(scenario.id);
  if (!runDir || !existsSync(runDir)) {
    throw new Error(`no raw run directory found for "${scenario.id}"（先跑 --judge dry）`);
  }
  const responseFile = join(runDir, "response.json");
  if (!existsSync(responseFile)) {
    throw new Error(
      `${responseFile} 不存在：把 dry 请求（request.json）交给判分模型，响应存为该文件后重跑 --judge response`,
    );
  }
  const reportFile = join(
    REPORTS_DIR,
    `report-${scenario.id}-${runDir
      .split(/[\\/]/)
      .pop()
      .slice(scenario.id.length + 1)}.json`,
  );
  const prior = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, "utf-8")) : undefined;
  const parsed = parseJudgeResponse(readFileSync(responseFile, "utf-8"));
  const score = scoreScenario(scenario, parsed);
  const judgeModel = process.argv.includes("--judge-model")
    ? process.argv[process.argv.indexOf("--judge-model") + 1]
    : undefined;
  const report = buildReport({
    scenarioId: scenario.id,
    runId: prior?.runId ?? runDir.split(/[\\/]/).pop(),
    status: "scored",
    judgeFingerprint: judgeFingerprintFor("operator", { model: judgeModel }),
    collection: prior?.collection ?? { note: "collection metadata missing (dry report not found)" },
    score: { ...score, judgeRaw: parsed.ok ? undefined : readFileSync(responseFile, "utf-8") },
  });
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  console.log(
    JSON.stringify(
      { reportFile, pass: report.pass, passRate: report.passRate, invalid: report.invalid },
      null,
      2,
    ),
  );
  return report;
}

async function dryFlow(scenario, recipe, evalRootArg) {
  // dist 新鲜度守护（fail-loud 于任何采集之前）。
  const freshness = checkDistFreshness(statSync(CLI_DIST).mtimeMs, latestSrcMtimeMs());
  if (!freshness.ok) throw new Error(freshness.reason);

  const runId = newRunId();
  const runDir = join(RAW_DIR, `${scenario.id}-${runId}`);
  mkdirSync(runDir, { recursive: true });
  const keepRoot = Boolean(evalRootArg);
  const evalRoot = evalRootArg ?? mkdtempSync(join(tmpdir(), "acode-eval-run-"));
  const dataBase = join(evalRoot, "data-base");
  const storage = join(evalRoot, "storage");
  const fixtureDir = join(evalRoot, "fixture");
  mkdirSync(join(dataBase, ".acode", "v2"), { recursive: true });
  mkdirSync(storage, { recursive: true });
  mkdirSync(fixtureDir, { recursive: true });
  // 凭据/配置复制（copy method：真实 profile 零触碰）。
  for (const name of readdirSync(REAL_V2_DIR)) {
    if (name.endsWith(".json"))
      copyFileSync(join(REAL_V2_DIR, name), join(dataBase, ".acode", "v2", name));
  }

  let server;
  const wallStart = Date.now();
  try {
    await recipe.setup(fixtureDir);
    server = recipe.server ? await recipe.server() : undefined;
    let deliverablePrompt = scenario.prompt;
    if (deliverablePrompt.startsWith("(")) {
      // 语料 prompt 以括号开头 = 舞台指示（如 "(subagent-side capture)"）：判分对象是
      // 子/后台会话，父侧投递语由 recipe.parentPrompt 声明；缺声明 = 支持面登记错误，
      // fail-loud 而不是把指示当 prompt 发出去。
      if (!recipe.parentPrompt) {
        throw new Error(
          `scenario "${scenario.id}" prompt is a stage direction and the recipe declares no parentPrompt（见 ${SPEC_REF} §R6）`,
        );
      }
      deliverablePrompt = recipe.parentPrompt;
    }
    const args = [
      CLI_DIST,
      "-p",
      deliverablePrompt,
      "--cwd",
      fixtureDir,
      "--output-format",
      "stream-json",
    ];
    if (recipe.mode) args.push("--mode", recipe.mode);
    const { code } = await runChild(process.execPath, args, {
      cwd: CLI_ROOT,
      env: { ...process.env, [ENV_STORAGE]: storage, [ENV_DATA_BASE]: dataBase },
      stdoutFile: join(runDir, "transcript.ndjson"),
      stderrFile: join(runDir, "run-stderr.log"),
      timeoutMs: recipe.timeoutMs ?? 15 * 60 * 1000,
    });
    const wallMs = Date.now() - wallStart;
    const ndjson = readFileSync(join(runDir, "transcript.ndjson"), "utf-8");
    const shaped = shapeTranscript(ndjson);
    writeFileSync(join(runDir, "transcript-shaped.txt"), shaped.text, "utf-8");

    // 子代理场景（§R6 judgeTarget:"child"）：判分对象是子转录（语料 setup 要求），
    // 父转录留盘仅作派发上下文。子工件定位与整形规则见 §R3/locateChildArtifacts。
    let judgedText = shaped.text;
    let judgedFile = join(runDir, "transcript-shaped.txt");
    let childMeta;
    if (recipe.judgeTarget === "child") {
      const parentSessionId = JSON.parse(
        ndjson.split(/\r?\n/).find((line) => line.trim()) ?? "{}",
      ).sessionId;
      const children = locateChildArtifacts(storage, parentSessionId);
      if (children.length !== 1) {
        throw new Error(
          `scenario "${scenario.id}" expects exactly one child session artifact, found ${children.length}` +
            (children.length
              ? `（${children.map((c) => c.description).join("; ")}）`
              : "（子代理未派发？检查父转录）"),
        );
      }
      const child = children[0];
      const childShaped = shapeChildTranscript(
        readFileSync(child.modelIoPath, "utf-8"),
        existsSync(child.reportPath) ? readFileSync(child.reportPath, "utf-8") : "",
      );
      writeFileSync(join(runDir, "transcript-child-shaped.txt"), childShaped.text, "utf-8");
      judgedText = childShaped.text;
      judgedFile = join(runDir, "transcript-child-shaped.txt");
      childMeta = { childBlocks: childShaped.blocksShaped, childChars: childShaped.shapedChars };
    }

    const notes = [];
    if (code !== 0) notes.push(`cli-exit-${code}`);
    if (recipe.experimental && !/notification|task-notification/i.test(ndjson)) {
      // §R6 experimental：进程早退未观察到后台完成事件——本身即产品行为发现，不算采集失败。
      notes.push(
        "background-orphan: process exited without observable background completion events",
      );
    }
    const collection = {
      distCommit: currentCommit(),
      cliMode: recipe.mode ?? "default",
      recipeDigest: recipeDigest(scenario.id),
      eventsTotal: shaped.eventsTotal,
      blocksShaped: shaped.blocksShaped,
      shapedChars: shaped.shapedChars,
      modelRequests: (ndjson.match(/"type":"model_request_started"/g) ?? []).length,
      wallMs,
      ...(childMeta ? { child: childMeta } : {}),
      ...(notes.length ? { notes } : {}),
    };

    // judge：三件套齐备走 live（复用 judge.mjs，不复制网络代码）；否则 dry 落请求文件。
    const liveEnvReady =
      process.env.PROMPT_EVAL_JUDGE_BASE_URL &&
      process.env.PROMPT_EVAL_JUDGE_API_KEY &&
      process.env.PROMPT_EVAL_JUDGE_MODEL;
    let status = "awaiting-judgement";
    let fingerprint = judgeFingerprintFor("pending");
    let score;
    const request = buildJudgeRequest(scenario, judgedText);
    writeFileSync(
      join(runDir, "request.json"),
      `${JSON.stringify({ scenarioId: scenario.id, ...request }, null, 2)}\n`,
      "utf-8",
    );
    if (liveEnvReady) {
      const liveOut = join(runDir, "live-report.json");
      await runChild(
        process.execPath,
        [
          join(HERE, "judge.mjs"),
          "--scenario",
          scenario.id,
          "--transcript",
          judgedFile,
          "--json-out",
          liveOut,
          "--live",
        ],
        {
          cwd: CLI_ROOT,
          env: process.env,
          stdoutFile: join(runDir, "judge-stdout.log"),
          stderrFile: join(runDir, "judge-stderr.log"),
          timeoutMs: 5 * 60 * 1000,
        },
      );
      score = JSON.parse(readFileSync(liveOut, "utf-8"));
      status = "scored";
      fingerprint = judgeFingerprintFor("live", {
        model: process.env.PROMPT_EVAL_JUDGE_MODEL,
        endpointHost: new URL(process.env.PROMPT_EVAL_JUDGE_BASE_URL).host,
      });
    }
    const report = buildReport({
      scenarioId: scenario.id,
      runId,
      status,
      judgeFingerprint: fingerprint,
      collection,
      score,
    });
    const reportFile = join(REPORTS_DIR, `report-${scenario.id}-${runId}.json`);
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    console.log(
      JSON.stringify(
        {
          reportFile,
          runDir,
          status,
          ...(score ? { pass: score.pass, passRate: score.passRate } : {}),
          next:
            status === "awaiting-judgement"
              ? `把 ${join(runDir, "request.json")} 交给判分模型，响应存为 ${join(runDir, "response.json")}，再跑 --judge response --run ${scenario.id}-${runId}`
              : undefined,
        },
        null,
        2,
      ),
    );
    return report;
  } finally {
    if (server?.close) await server.close();
    cleanupEvalRoot(evalRoot, { keepRoot });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const getFlag = (name) => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? undefined : args[index + 1];
  };
  const scenarioId = getFlag("scenario");
  const judgeMode = getFlag("judge") ?? "dry";
  if (!scenarioId || !["dry", "response"].includes(judgeMode)) {
    console.error(
      `usage: node evals/runner.mjs --scenario <id> [--judge dry|response] [--eval-root <dir>] [--run <runId>] [--judge-model <id>]\n详见 ${SPEC_REF}`,
    );
    process.exit(2);
  }
  const scenarios = await loadScenarios();
  const scenario = scenarios.find((item) => item.id === scenarioId);
  if (!scenario) {
    console.error(
      `unknown scenario id: ${scenarioId}\navailable: ${scenarios.map((s) => s.id).join(", ")}`,
    );
    process.exit(2);
  }
  if (judgeMode === "response") {
    const report = await judgeResponseFlow(scenario, getFlag("run"));
    process.exit(report.pass ? 0 : 1);
  }
  const recipe = await loadRecipe(scenarioId);
  await dryFlow(scenario, recipe, getFlag("eval-root"));
  process.exit(0);
}

const isMain =
  typeof process.argv[1] === "string" &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(`runner failed: ${error.message}`);
    process.exit(1);
  });
}
