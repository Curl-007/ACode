// 统一类型门禁（scripts/typecheck-gate.mjs）的行为与旁路验收。
//
// 放在 apps/acode-cli/tests 与 architecture-*.test.mjs 同因：根 scripts/ 没有自己的
// 测试入口，仓库级工具测试历来挂在这里，随 `pnpm test` 进 CI。
//
// 覆盖 docs/specs/cli-validation-gates.md 的三条验收：
// 1. 注入验收——含类型错误的阶段必须让门禁退出非零并指名阶段（对应 U01 的 T02/T03）；
// 2. 依赖顺序与真实并行——barrier 之后无依赖关系的阶段确实并行，串行则超时失败；
// 3. 旁路验收——workflow 与根 package.json 不存在跳过 renderer/CLI 的第二条路径。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { TYPECHECK_STAGES } from "../../../scripts/typecheck-gate.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const gateScript = join(repoRoot, "scripts", "typecheck-gate.mjs");
const tscEntry = join(repoRoot, "node_modules", "typescript", "bin", "tsc");

async function fixtureDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }));
  return dir;
}

function runGate(args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [gateScript, ...args], { cwd: repoRoot, shell: false });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`门禁运行超时（${timeoutMs}ms）：${args.join(" ")}\n${output}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, output });
    });
  });
}

async function writeStagesFile(dir, stages) {
  const file = join(dir, "stages.json");
  await writeFile(file, JSON.stringify(stages, null, 2), "utf8");
  return file;
}

// 独立的临时 tsconfig：不 extends 仓库基线、types: []，避免把整个仓库的类型图
// 拉进注入测试，让它保持在秒级并且只反映被注入的那一个错误。
async function writeTsFixture(dir, sourceText) {
  await writeFile(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          types: [],
        },
        include: ["*.ts"],
      },
      null,
      2,
    ),
    "utf8",
  );
  const sourceFile = join(dir, "injected.ts");
  await writeFile(sourceFile, sourceText, "utf8");
  return { tsconfig: join(dir, "tsconfig.json"), sourceFile };
}

test("注入类型错误的阶段让门禁退出非零并指名阶段", async (t) => {
  const dir = await fixtureDir(t, "acode-typecheck-gate-fail-");
  const { tsconfig, sourceFile } = await writeTsFixture(dir, "export const value: number = \"not a number\";\n");
  const stagesFile = await writeStagesFile(dir, [
    {
      id: "injected-entry",
      label: "注入错误的入口",
      command: "node",
      args: [tscEntry, "-p", tsconfig, "--noEmit"],
      dependsOn: [],
    },
  ]);

  const { code, output } = await runGate(["--stages-file", stagesFile], { timeoutMs: 90_000 });

  assert.notEqual(code, 0, `门禁必须失败，实际退出码 ${code}\n${output}`);
  assert.match(output, /\[injected-entry\]/, "输出必须指名失败阶段");
  assert.match(output, /失败/, "输出必须给出失败结论");
  // 定位到注入文件本身，证明失败不是来自其它噪声。
  assert.ok(output.includes(sourceFile) || output.includes("injected.ts"), `输出必须定位注入文件：\n${output}`);
  assert.match(output, /复现命令/, "失败时必须给出复现命令");
});

test("移除注入后同一入口退出 0", async (t) => {
  const dir = await fixtureDir(t, "acode-typecheck-gate-pass-");
  const { tsconfig } = await writeTsFixture(dir, "export const value: number = 1;\n");
  const stagesFile = await writeStagesFile(dir, [
    { id: "clean-entry", command: "node", args: [tscEntry, "-p", tsconfig, "--noEmit"], dependsOn: [] },
  ]);

  const { code, output } = await runGate(["--stages-file", stagesFile], { timeoutMs: 90_000 });

  assert.equal(code, 0, `门禁应通过：\n${output}`);
  assert.match(output, /done\s+clean-entry/, "汇总必须记录该阶段完成");
});

test("依赖阶段失败时下游标记 skipped 且门禁失败", async (t) => {
  const dir = await fixtureDir(t, "acode-typecheck-gate-skip-");
  const { tsconfig } = await writeTsFixture(dir, "export const value: number = \"not a number\";\n");
  const stagesFile = await writeStagesFile(dir, [
    { id: "broken", command: "node", args: [tscEntry, "-p", tsconfig, "--noEmit"], dependsOn: [] },
    { id: "downstream", command: "node", args: ["-e", "process.exit(0)"], dependsOn: ["broken"] },
  ]);

  const { code, output } = await runGate(["--stages-file", stagesFile], { timeoutMs: 90_000 });

  assert.notEqual(code, 0, `门禁必须失败：\n${output}`);
  assert.match(output, /\[downstream\] 跳过：门禁已失败，未执行/, "下游必须显式跳过而不是静默不跑");
  assert.match(output, /skipped\s+downstream/, "汇总必须区分 skipped 与 done");
});

test("barrier 之后无依赖关系的阶段真实并行，串行会超时失败", async (t) => {
  const dir = await fixtureDir(t, "acode-typecheck-gate-parallel-");
  const marker = join(dir, "writer.marker").replaceAll("\\", "/");
  const log = join(dir, "order.log").replaceAll("\\", "/");
  // waiter 以轮询等待 writer 的 marker：若门禁串行执行且 waiter 先跑，它会等到
  // 超时并非零退出，从而让本用例失败——这就是并行性的可证伪对照。
  const waiterSource = [
    "const fs = require('node:fs');",
    "const start = Date.now();",
    "(async () => {",
    `  while (!fs.existsSync(${JSON.stringify(marker)})) {`,
    "    if (Date.now() - start > 15000) { process.exit(3); }",
    "    await new Promise((r) => setTimeout(r, 20));",
    "  }",
    `  fs.appendFileSync(${JSON.stringify(log)}, 'waiter-done\\n');`,
    "})();",
  ].join("");
  const writerSource = [
    "const fs = require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(log)}, 'writer-start\\n');`,
    `fs.writeFileSync(${JSON.stringify(marker)}, '1');`,
  ].join("");
  const joinSource = `require('node:fs').appendFileSync(${JSON.stringify(log)}, 'joined\\n');`;

  const stagesFile = await writeStagesFile(dir, [
    { id: "waiter", command: "node", args: ["-e", waiterSource], dependsOn: [] },
    { id: "writer", command: "node", args: ["-e", writerSource], dependsOn: [] },
    { id: "joined", command: "node", args: ["-e", joinSource], dependsOn: ["waiter", "writer"] },
  ]);

  const { code, output } = await runGate(["--stages-file", stagesFile], { timeoutMs: 60_000 });
  assert.equal(code, 0, `并行执行应通过：\n${output}`);

  const lines = (await readFile(log, "utf8")).split("\n").filter(Boolean);
  assert.deepEqual(lines, ["writer-start", "waiter-done", "joined"], `事件顺序不符：${lines.join(",")}`);
});

test("同一清单以 --sequential 运行时并行对照失败", async (t) => {
  const dir = await fixtureDir(t, "acode-typecheck-gate-serial-");
  const marker = join(dir, "writer.marker").replaceAll("\\", "/");
  const log = join(dir, "order.log").replaceAll("\\", "/");
  const waiterSource = [
    "const fs = require('node:fs');",
    "const start = Date.now();",
    "(async () => {",
    `  while (!fs.existsSync(${JSON.stringify(marker)})) {`,
    "    if (Date.now() - start > 4000) { process.exit(3); }",
    "    await new Promise((r) => setTimeout(r, 20));",
    "  }",
    `  fs.appendFileSync(${JSON.stringify(log)}, 'waiter-done\\n');`,
    "})();",
  ].join("");
  const writerSource = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '1');`;
  const stagesFile = await writeStagesFile(dir, [
    { id: "waiter", command: "node", args: ["-e", waiterSource], dependsOn: [] },
    { id: "writer", command: "node", args: ["-e", writerSource], dependsOn: [] },
  ]);

  const { code, output } = await runGate(["--stages-file", stagesFile, "--sequential"], { timeoutMs: 60_000 });

  assert.notEqual(code, 0, `串行模式下 waiter 必须超时失败，否则并行用例没有鉴别力：\n${output}`);
});

test("默认清单覆盖三个入口且 packages 是 barrier", async () => {
  const ids = TYPECHECK_STAGES.map((stage) => stage.id);
  assert.deepEqual(ids, ["packages", "desktop-renderer", "cli"]);

  const byId = new Map(TYPECHECK_STAGES.map((stage) => [stage.id, stage]));
  const packages = byId.get("packages");
  assert.deepEqual(packages.dependsOn, [], "barrier 阶段不得有依赖");
  assert.equal(packages.args[0], "node_modules/typescript/bin/tsc");
  assert.equal(packages.args[1], "-b");
  // 迁移前 package.json typecheck 的工程清单，逐项对齐，少一个就是覆盖面回退。
  assert.deepEqual(packages.args.slice(2), [
    "packages/rpc",
    "packages/provider",
    "packages/provider-node",
    "packages/shared",
    "packages/harness-sdk",
    "packages/services",
    "packages/client",
    "packages/server",
    "packages/acode-server-cli",
    "packages/ui",
    "packages/web",
    "packages/desktop/tsconfig.host.json",
    "packages/desktop/tsconfig.main.json",
    "packages/desktop/tsconfig.preload.json",
    "packages/desktop/tsconfig.scheduler.json",
  ]);

  const renderer = byId.get("desktop-renderer");
  assert.deepEqual(renderer.dependsOn, ["packages"], "renderer 读 packages 的声明，必须排在其后");
  assert.deepEqual(renderer.args.slice(1), ["-p", "packages/desktop/tsconfig.renderer.json", "--noEmit"]);

  const cli = byId.get("cli");
  assert.deepEqual(cli.dependsOn, ["packages"]);
  assert.deepEqual(cli.args, ["node_modules/turbo/bin/turbo", "--cwd", "apps/acode-cli", "run", "typecheck"]);
});

test("workflow 与根 package.json 不存在跳过 renderer/CLI 的旁路", async () => {
  const rootPackage = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  assert.equal(
    rootPackage.scripts.typecheck,
    "node scripts/typecheck-gate.mjs",
    "根 typecheck 必须指向单一门禁入口",
  );

  for (const workflow of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
    const text = await readFile(join(repoRoot, workflow), "utf8");
    const runLines = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("run:") && line.includes("typecheck"));
    assert.ok(runLines.length > 0, `${workflow} 应当仍有类型检查步骤`);
    for (const line of runLines) {
      assert.equal(line, "run: pnpm typecheck", `${workflow} 出现绕过统一入口的命令：${line}`);
    }
    // 单入口内联命令与门禁缩小开关都不允许再出现在流水线里。
    for (const forbidden of [
      "tsconfig.renderer.json",
      "apps/acode-cli/packages/cli typecheck",
      "typecheck-gate.mjs --only",
      "--stages-file",
    ]) {
      assert.ok(!text.includes(forbidden), `${workflow} 不应再出现 ${forbidden}`);
    }
  }
});
