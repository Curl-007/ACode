import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * R6 边界⑥收口验收测试：npm/pnpm/yarn/bun run 的 script 体扫描。
 *
 * 覆盖规格 apps/acode-cli/specs/npm-script-body-scan.md 的 R1–R6 与验收矩阵：
 * - A：纯模块分级（TargetRiskContext.packageScripts 注入；bash-target-risk 零 IO）；
 * - B：接线层预取（collectBashPackageScriptSources，OS temp 造假 package.json 树）；
 * - C：决策链（breaker deny / 反射门 / PermissionService yolo 端到端）；
 * - D：executor 接缝（resolveToolPermission 经 resolvePermissionCapabilityContextAsync
 *   端到端：生产链路保证 cwd 可达 package.json 时 map 一定注入）。
 * 不碰真实用户数据：所有 IO 都在 mkdtemp 出来的目录里。
 */

const { assessBashCommandTargetRisk, PACKAGE_MANAGER_PROGRAMS } = await import(
  "../packages/core/src/tool/handlers/bash-target-risk/index.ts"
);
const { collectBashPackageScriptSources } = await import(
  "../packages/core/src/tool/handlers/bash-package-script-context.ts"
);
const { evaluateBypassImmuneBreakers } = await import(
  "../packages/core/src/permission/bypass-immune-breakers.ts"
);
const { PermissionService } = await import("../packages/core/src/permission/service.ts");
const { bashToolEntry } = await import("../packages/core/src/tool/handlers/bash.ts");
const { resolveToolPermission } = await import(
  "../packages/core/src/tool/executor/permission-flow.ts"
);

// ── A：纯模块分级 ─────────────────────────────────────────────────────

const HOME = "/home/u";
const PKG_DIR = "/home/u/proj";

function context(scripts, extra = {}) {
  return {
    workingDirectory: PKG_DIR,
    workspaceRoot: PKG_DIR,
    homeDirectory: HOME,
    platform: "linux",
    packageScripts: scripts === undefined ? undefined : [{ directory: PKG_DIR, scripts }],
    ...extra,
  };
}

function level(command, scripts, extra = {}) {
  return assessBashCommandTargetRisk(command, context(scripts, extra)).level;
}

test("A1 日常命令零摩擦：npm run clean（body=rimraf dist）→ low（不打断）", () => {
  assert.equal(level("npm run clean", { clean: "rimraf dist" }), "low");
});

test("A1 日常命令零摩擦：pnpm lint（body=oxlint）/ npm run build（body=node scripts/build.js）→ safe", () => {
  assert.equal(level("pnpm lint", { lint: "oxlint" }), "safe");
  assert.equal(level("npm run build", { build: "node scripts/build.js" }), "safe");
  assert.equal(level("yarn test", { test: "vitest run" }), "safe");
});

test("A2 body=catastrophic 形态：rimraf ~ / rm -rf ~/.ssh / cd ~ && rm -rf .ssh", () => {
  assert.equal(level("npm run pwn", { pwn: "rimraf ~" }), "catastrophic");
  assert.equal(level("npm run pwn", { pwn: "rm -rf ~/.ssh" }), "catastrophic");
  assert.equal(level("npm run pwn", { pwn: "cd ~ && rm -rf .ssh" }), "catastrophic");
  assert.equal(level("yarn clean", { clean: "rm -rf $HOME" }), "catastrophic");
  assert.equal(level("bun run wipe", { wipe: "rm -rf /etc" }), "catastrophic");
});

test("A3 npm test 别名走 body；pre/post 钩子一并评估", () => {
  assert.equal(level("npm test", { test: "rm -rf /etc/passwd" }), "catastrophic");
  assert.equal(level("npm start", { start: "rimraf ~" }), "catastrophic");
  assert.equal(level("pnpm test", { test: "rm -rf ~" }), "catastrophic");
  assert.equal(
    level("npm run build", { build: "echo ok", prebuild: "rm -rf /etc/passwd" }),
    "catastrophic",
    "prebuild 危险时 npm run build 必须拦",
  );
  assert.equal(
    level("npm run build", { build: "echo ok", postbuild: "rm -rf /etc/passwd" }),
    "catastrophic",
    "postbuild 危险时 npm run build 必须拦",
  );
  assert.equal(
    level("npm run build", { build: "echo ok", preother: "rm -rf ~" }),
    "safe",
    "无关前缀不误伤",
  );
});

test("A4 嵌套 run 递归：a→b→rm -rf /etc/passwd → catastrophic", () => {
  assert.equal(
    level("npm run a", { a: "npm run b", b: "rm -rf /etc/passwd" }),
    "catastrophic",
  );
});

test("A4 嵌套超深度 → confirm（fail-closed）", () => {
  const chain = {
    deep1: "npm run deep2",
    deep2: "npm run deep3",
    deep3: "npm run deep4",
    deep4: "npm run deep5",
    deep5: "npm run deep6",
    deep6: "rimraf ~",
  };
  assert.equal(level("npm run deep1", chain), "confirm");
});

test("A5 动态 script 名 → confirm；npm run（无名）/名字不在 map/无 package.json → safe", () => {
  assert.equal(level("npm run $X", { clean: "rimraf dist" }), "confirm");
  assert.equal(level("npm run", { clean: "rimraf dist" }), "safe");
  assert.equal(level("yarn run", {}), "safe");
  assert.equal(level("npm run nothere", { clean: "rimraf dist" }), "safe");
  assert.equal(level("npm run clean", {}, { packageScripts: [] }), "safe", "空数组 = 预取确认无包");
  assert.equal(level("npm run clean", { clean: "rimraf dist" }), "low");
});

test("A6 native 动词不按 script 处理：pnpm install / bun test / npm publish", () => {
  assert.equal(level("pnpm install", { install: "rm -rf /etc/passwd" }), "safe");
  assert.equal(level("bun test", { test: "rimraf ~" }), "safe");
  assert.equal(level("npm publish", { publish: "rimraf ~" }), "safe");
  assert.equal(level("npm run install", { install: "rm -rf /etc/passwd" }), "catastrophic", "显式 run 仍查 map");
});

test("A7 --filter 静态路径 → 目标包 body；名字形/缺失 → confirm", () => {
  const ws = {
    workingDirectory: "/home/u/ws",
    workspaceRoot: "/home/u/ws",
    homeDirectory: HOME,
    platform: "linux",
    packageScripts: [
      { directory: "/home/u/ws", scripts: { lint: "oxlint" } },
      { directory: "/home/u/ws/packages/x", scripts: { evil: "rm -rf /etc/passwd" } },
    ],
  };
  const assessed = (command) => assessBashCommandTargetRisk(command, ws).level;
  assert.equal(assessed("pnpm --filter ./packages/x run evil"), "catastrophic");
  assert.equal(assessed("pnpm -F ./packages/x run evil"), "catastrophic", "短旗标同款");
  assert.equal(assessed("pnpm --filter=./packages/x run evil"), "catastrophic", "= 粘连形态");
  assert.equal(assessed("pnpm --filter web run dev"), "confirm", "名字形选择器不可解析");
  assert.equal(assessed("pnpm --filter ./missing run x"), "confirm", "静态路径无 source fail-closed");
});

test("A8 目录选择器：npm --prefix / pnpm -C 指向其他包", () => {
  const ws = {
    workingDirectory: "/home/u/ws",
    workspaceRoot: "/home/u/ws",
    homeDirectory: HOME,
    platform: "linux",
    packageScripts: [
      { directory: "/home/u/ws", scripts: { lint: "oxlint" } },
      { directory: "/home/u/ws/server", scripts: { clean: "rimraf ~" } },
    ],
  };
  const assessed = (command) => assessBashCommandTargetRisk(command, ws).level;
  assert.equal(assessed("npm --prefix ./server run clean"), "catastrophic");
  assert.equal(assessed("pnpm -C ./server run clean"), "catastrophic");
  assert.equal(assessed("pnpm --dir ./server run clean"), "catastrophic");
  assert.equal(assessed("yarn --cwd ./server run clean"), "catastrophic");
});

test("A9 未知旗标 / 递归范围 → confirm（fail-closed）", () => {
  assert.equal(level("npm --totally-unknown run clean", { clean: "rimraf ~" }), "confirm");
  assert.equal(level("pnpm -r build", { build: "echo ok" }), "confirm");
  assert.equal(level("npm --workspace app run build", { build: "echo ok" }), "confirm");
});

test("A10 转发参数拼进 main body：npm run clean -- ~ → catastrophic", () => {
  assert.equal(level("npm run clean -- ~", { clean: "rimraf dist" }), "catastrophic");
});

test("A11 body 走既有未解析规则：rm -rf $OUT/../etc → catastrophic（.. 逃逸）", () => {
  assert.equal(level("npm run body", { body: "rm -rf $OUT/../etc" }), "catastrophic");
  assert.equal(level("npm run body", { body: "rm -rf $TARGET" }), "confirm");
});

test("A12 legacy（map 未注入）维持现行为：run 直通 safe", () => {
  assert.equal(level("npm run clean", undefined), "safe");
  assert.equal(level("npm run $X", undefined), "safe");
  assert.equal(level("pnpm --filter ./x run evil", undefined), "safe");
  assert.equal(PACKAGE_MANAGER_PROGRAMS.has("npm"), true);
});

test("A13 fallback 口径：subshell/if 包裹的 npm run 与裸命令同判（一层括号不降级）", () => {
  assert.equal(level("(npm run pwn)", { pwn: "rimraf ~" }), "catastrophic");
  assert.equal(level("if true; then npm run pwn; fi", { pwn: "rimraf ~" }), "catastrophic");
  assert.equal(level("(sudo npm run pwn)", { pwn: "rimraf ~" }), "catastrophic");
});

test("A14 多命令段：干净段 + 危险段 → catastrophic", () => {
  assert.equal(
    level("npm run ok && npm run pwn", { ok: "echo hi", pwn: "rimraf ~" }),
    "catastrophic",
  );
});

test("A15 bun x（包运行器 payload）在 map 注入时递归评估", () => {
  assert.equal(level("bun x rimraf ~", {}), "catastrophic");
  assert.equal(level("bun x rimraf ~", undefined), "safe", "legacy 维持现行为");
});

// ── B：接线层预取（OS temp 造假 package.json 树） ─────────────────────

async function withTempTree(run) {
  // 长名归一：%TEMP% 在本机是 8.3 短名，短名 workspace 会让目标 blast-radius 分级
  // 走「无法静态验证」的反射门，测到短名形态而不是 script body 扫描语义。
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "npm-script-scan-")));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("B1 预取：最近 package.json + 子包 + --filter 候选（monorepo 两层树）", async () => {
  await withTempTree(async (root) => {
    await mkdir(join(root, "packages", "x"), { recursive: true });
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "root", scripts: { clean: "rimraf dist", lint: "oxlint" } }),
    );
    await writeFile(
      join(root, "packages", "x", "package.json"),
      JSON.stringify({ name: "x", scripts: { evil: "rm -rf /etc/passwd" } }),
    );
    await writeFile(
      join(root, "sub", "package.json"),
      JSON.stringify({ name: "sub", scripts: { clean: "rimraf ~" } }),
    );

    // cwd 在子包：最近 source 是子包的（monorepo 主场景）。
    const fromSub = await collectBashPackageScriptSources("npm run clean", {
      workingDirectory: join(root, "sub"),
      workspaceRoot: root,
    });
    assert.equal(fromSub.sources.length, 1);
    assert.equal(fromSub.sources[0].directory, join(root, "sub"));
    assert.equal(fromSub.sources[0].scripts.clean, "rimraf ~");
    assert.ok(
      fromSub.scannedDirectories.includes(join(root, "sub")),
      "走过目录进覆盖证据（F1②）",
    );

    // cwd 在根：最近 source 是根；--filter 候选把 packages/x 也带进来。
    const fromRoot = await collectBashPackageScriptSources(
      "pnpm --filter ./packages/x run evil",
      { workingDirectory: root, workspaceRoot: root },
    );
    const dirs = fromRoot.sources.map((source) => source.directory).sort();
    assert.deepEqual(dirs, [join(root), join(root, "packages", "x")]);
    assert.equal(
      fromRoot.sources.find((s) => s.directory.endsWith("x")).scripts.evil,
      "rm -rf /etc/passwd",
    );
    assert.ok(
      fromRoot.scannedDirectories.includes(join(root, "packages", "x")),
      "选择器候选的向上走同样进覆盖证据（F1②）",
    );
  });
});

test("B2 预取容错：坏 JSON / 超限 / 无包 / 垃圾命令不抛且跳过", async () => {
  await withTempTree(async (root) => {
    await mkdir(join(root, "broken"), { recursive: true });
    await mkdir(join(root, "huge"), { recursive: true });
    await writeFile(join(root, "broken", "package.json"), "{ not json !!!");
    await writeFile(
      join(root, "huge", "package.json"),
      `{"pad":"${"x".repeat(1024 * 1024 + 16)}"}`,
    );

    // broken 目录无可解析包（坏 JSON 止走，对抗验证 F4）：不产生 source，且向上走
    // 止于坏文件——不产生覆盖证据（npm 读到的就是这份坏文件）。
    const broken = await collectBashPackageScriptSources("npm run x", {
      workingDirectory: join(root, "broken"),
      workspaceRoot: root,
    });
    assert.deepEqual(broken.sources, [], "坏 JSON 不产生 source");
    assert.deepEqual(broken.scannedDirectories, [], "坏 JSON 止走且不产生覆盖证据（F4）");

    const huge = await collectBashPackageScriptSources("npm run x", {
      workingDirectory: join(root, "huge"),
      workspaceRoot: root,
    });
    assert.deepEqual(huge.sources, [], "超限文件不产生 source");

    const noManager = await collectBashPackageScriptSources("echo hi && rm -rf dist", {
      workingDirectory: root,
      workspaceRoot: root,
    });
    assert.deepEqual(noManager.sources, [], "无包管理器词不做 IO");

    const garbage = await collectBashPackageScriptSources("npm run x", {});
    assert.deepEqual(garbage.sources, [], "无 cwd 基准返回空");
  });
});

test("B3 预取注满模块：temp 树端到端（最近 + filter 两个 source 都评估）", async () => {
  await withTempTree(async (root) => {
    await mkdir(join(root, "packages", "x"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { lint: "oxlint" } }),
    );
    await writeFile(
      join(root, "packages", "x", "package.json"),
      JSON.stringify({ scripts: { evil: "rm -rf /etc/passwd" } }),
    );
    const prefetch = await collectBashPackageScriptSources(
      "pnpm --filter ./packages/x run evil",
      { workingDirectory: root, workspaceRoot: root },
    );
    const assessment = assessBashCommandTargetRisk("pnpm --filter ./packages/x run evil", {
      workingDirectory: root,
      workspaceRoot: root,
      homeDirectory: homedir(),
      platform: process.platform,
      packageScripts: prefetch.sources,
      scannedDirectories: prefetch.scannedDirectories,
    });
    assert.equal(assessment.level, "catastrophic");
  });
});

// ── C：决策链（deny / 反射门 / yolo 端到端） ──────────────────────────

const EVIL_MAP = [{ directory: PKG_DIR, scripts: { clean: "rimraf ~" } }];
const CRITICAL_CAPABILITY = {
  destructive: true,
  needsApproval: true,
  readOnly: false,
  riskLevel: "critical",
  sideEffectScope: "system",
  permission: { needsApproval: true, riskLevel: "critical", sideEffectScope: "system" },
};

test("C1 熔断器：body catastrophic → breaker.bashTargetCatastrophic + behavior deny", () => {
  const hit = evaluateBypassImmuneBreakers({
    toolName: "Bash",
    input: { command: "npm run clean" },
    workingDirectory: PKG_DIR,
    workspaceRoot: PKG_DIR,
    packageScripts: EVIL_MAP,
  });
  assert.equal(hit?.ruleId, "breaker.bashTargetCatastrophic");
  assert.equal(hit?.behavior, "deny");
  assert.match(hit?.reason ?? "", /rimraf|protected/i);
});

test("C2 决策链验证（关键验收）：yolo + body catastrophic → deny，不得静默 allow", () => {
  const service = new PermissionService();
  const decision = service.checkPermission(
    {
      toolName: "Bash",
      input: { command: "npm run clean" },
      riskLevel: "high",
      mode: "yolo",
      workingDirectory: PKG_DIR,
      workspaceRoot: PKG_DIR,
      packageScripts: EVIL_MAP,
    },
    CRITICAL_CAPABILITY,
  );
  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, "breaker.bashTargetCatastrophic");
  assert.equal(decision.allowed, false);
});

test("C2 build 模式同样 deny（deny 级熔断压过 ask）", () => {
  const service = new PermissionService();
  const decision = service.checkPermission(
    {
      toolName: "Bash",
      input: { command: "npm run clean" },
      riskLevel: "high",
      mode: "build",
      workingDirectory: PKG_DIR,
      workspaceRoot: PKG_DIR,
      packageScripts: EVIL_MAP,
    },
    CRITICAL_CAPABILITY,
  );
  assert.equal(decision.decision, "deny");
});

test("C3 confirm 级 body（npm run $X）在 yolo 下进反射门：首轮 reflect deny", () => {
  const service = new PermissionService();
  const decision = service.checkPermission(
    {
      toolName: "Bash",
      input: { command: "npm run $X" },
      riskLevel: "high",
      mode: "yolo",
      workingDirectory: PKG_DIR,
      workspaceRoot: PKG_DIR,
      sessionId: "session-r6",
      packageScripts: EVIL_MAP,
    },
    CRITICAL_CAPABILITY,
  );
  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, "gate.bashConfirmReflex.reflect");
});

test("C4 legacy（PermissionContext 无 map）维持现行为：yolo allow", () => {
  const service = new PermissionService();
  const decision = service.checkPermission(
    {
      toolName: "Bash",
      input: { command: "npm run clean" },
      riskLevel: "high",
      mode: "yolo",
      workingDirectory: PKG_DIR,
      workspaceRoot: PKG_DIR,
    },
    { destructive: false, readOnly: false, riskLevel: "high", sideEffectScope: "workspace" },
  );
  assert.equal(decision.decision, "allow");
  assert.equal(decision.ruleId, "mode.yolo");
});

test("C5 capability 接线：危险 body → critical；日常 body 不打断", () => {
  const critical = bashToolEntry.resolvePermissionCapability?.(
    { command: "npm run clean" },
    { workingDirectory: PKG_DIR, workspaceRoot: PKG_DIR, packageScripts: EVIL_MAP },
  );
  assert.equal(critical?.riskLevel, "critical");
  assert.equal(critical?.destructive, true);

  const daily = bashToolEntry.resolvePermissionCapability?.(
    { command: "npm run clean" },
    {
      workingDirectory: PKG_DIR,
      workspaceRoot: PKG_DIR,
      packageScripts: [{ directory: PKG_DIR, scripts: { clean: "rimraf dist" } }],
    },
  );
  assert.equal(daily, undefined, "low 档不升级既有 riskLevel（entry 默认照旧）");

  const confirmLevel = bashToolEntry.resolvePermissionCapability?.(
    { command: "npm run $X" },
    { workingDirectory: PKG_DIR, workspaceRoot: PKG_DIR, packageScripts: EVIL_MAP },
  );
  assert.equal(confirmLevel?.riskLevel, "critical");
});

// ── D：executor 接缝端到端（生产链路注入保证） ────────────────────────

function executorDeps(directory) {
  return {
    permissionService: new PermissionService(),
    emitEvent: async () => undefined,
    sessionId: "session-r6-e2e",
    getWorkingDirectory: () => directory,
    getWorkspaceRoot: () => directory,
    runtimeScope: "main",
  };
}

test("D1 executor 端到端：yolo + 恶意 body package.json → deny（预取自动注入）", async () => {
  await withTempTree(async (root) => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { clean: "rimraf ~" } }),
    );
    const result = await resolveToolPermission(
      executorDeps(root),
      { id: "call-r6-1", name: "Bash", input: { command: "npm run clean" } },
      bashToolEntry,
      { command: "npm run clean" },
      {},
      "yolo",
      { traceId: "trace-r6" },
    );
    assert.equal(result.allowed, false);
    assert.match(result.result.error?.message ?? "", /blocked/i);
    assert.match(
      result.result.error?.message ?? "",
      /never permitted/i,
      "deny 文案来自 breaker.bashTargetCatastrophic 通道",
    );
  });
});

test("D2 executor 端到端：日常 clean 脚本 yolo 直通（零摩擦）", async () => {
  await withTempTree(async (root) => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { clean: "rimraf dist" } }),
    );
    const result = await resolveToolPermission(
      executorDeps(root),
      { id: "call-r6-2", name: "Bash", input: { command: "npm run clean" } },
      bashToolEntry,
      { command: "npm run clean" },
      {},
      "yolo",
      { traceId: "trace-r6" },
    );
    assert.equal(result.allowed, true, "body=rimraf dist 是工作区内有界破坏（low），yolo 放行");
  });
});

test("D3 executor 端到端：无 package.json 的目录 yolo 直通", async () => {
  await withTempTree(async (root) => {
    const result = await resolveToolPermission(
      executorDeps(root),
      { id: "call-r6-3", name: "Bash", input: { command: "npm run clean" } },
      bashToolEntry,
      { command: "npm run clean" },
      {},
      "yolo",
      { traceId: "trace-r6" },
    );
    assert.equal(result.allowed, true, "无包 → 命令天然失败 → safe 直通");
  });
});

// ── E：对抗验证 F1（预取覆盖面 = npm 就近语义 + 覆盖证明 fail-closed） ──

async function assessedWithPrefetch(command, root) {
  const prefetch = await collectBashPackageScriptSources(command, {
    workingDirectory: root,
    workspaceRoot: root,
  });
  return assessBashCommandTargetRisk(command, {
    workingDirectory: root,
    workspaceRoot: root,
    homeDirectory: homedir(),
    platform: process.platform,
    packageScripts: prefetch.sources,
    scannedDirectories: prefetch.scannedDirectories,
  }).level;
}

test("E1 [F1] cd/pushd 目标预取：子包 body 危险时 cd 族全部 catastrophic", async () => {
  await withTempTree(async (root) => {
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { clean: "echo ok" } }));
    await writeFile(
      join(root, "sub", "package.json"),
      JSON.stringify({ scripts: { clean: "rimraf ~" } }),
    );
    for (const command of [
      "cd sub && npm run clean",
      "cd sub; npm run clean",
      "pushd sub && npm run clean",
      "cd ./sub && npm run clean",
      "(cd sub && npm run clean)",
      'sh -c "cd sub && npm run clean"',
    ]) {
      assert.equal(await assessedWithPrefetch(command, root), "catastrophic", `${command} → 子包 body 生效`);
    }
  });
});

test("E2 [F1②] 覆盖证明 fail-closed：目标未被扫描时 enclosing 不放行（模拟①失效）", () => {
  // 人为让①失效：只注入根包 source + 根目录的覆盖证据（sub 未预取）。
  const partial = {
    workingDirectory: PKG_DIR,
    workspaceRoot: PKG_DIR,
    homeDirectory: HOME,
    platform: "linux",
    packageScripts: [{ directory: PKG_DIR, scripts: { clean: "rimraf ~" } }],
    scannedDirectories: [PKG_DIR],
  };
  const assess = (command) => assessBashCommandTargetRisk(command, partial).level;
  assert.equal(assess("cd sub && npm run clean"), "confirm", "目标严格深于 enclosing 且未覆盖 → confirm");
  assert.equal(
    assess("npm run clean"),
    "catastrophic",
    "cwd 本身被覆盖（初始目录）→ 照常评估 body",
  );
});

test("E3 [F1②] 未解析 cd 目标 → confirm（unresolved 兜底不回归）", async () => {
  await withTempTree(async (root) => {
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { clean: "echo ok" } }));
    await writeFile(
      join(root, "sub", "package.json"),
      JSON.stringify({ scripts: { clean: "rimraf ~" } }),
    );
    assert.equal(await assessedWithPrefetch("cd $D && npm run clean", root), "confirm");
  });
});

test("E4 [F1] 嵌套 body 选择器目标：body 第二遍扫描（release:cli → 子包 body）", async () => {
  await withTempTree(async (root) => {
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        scripts: { "release:cli": "pnpm --dir sub run release", release: "echo harmless" },
      }),
    );
    await writeFile(
      join(root, "sub", "package.json"),
      JSON.stringify({ scripts: { release: "rimraf ~" } }),
    );
    assert.equal(
      await assessedWithPrefetch("npm run release:cli", root),
      "catastrophic",
      "嵌套 body 里的 --dir sub 目标被第二遍扫描覆盖 → 评的是子包 body",
    );
    // 禁止回落 enclosing：同树、②路径（模拟①失效）→ confirm 而非评根包同名 script。
    const prefetch = await collectBashPackageScriptSources("pnpm --dir sub run release", {
      workingDirectory: root,
      workspaceRoot: root,
    });
    const stripped = {
      workingDirectory: root,
      workspaceRoot: root,
      homeDirectory: homedir(),
      platform: process.platform,
      // 只留根包 source，模拟①失效（sub 未注册）；覆盖证据同样剔除 sub。
      packageScripts: prefetch.sources.filter((source) => source.directory === root),
      scannedDirectories: [root],
    };
    assert.equal(
      assessBashCommandTargetRisk("pnpm --dir sub run release", stripped).level,
      "confirm",
      "选择器目标不匹配任何 source 且未覆盖 → confirm，禁止回落根包 map",
    );
  });
});

test("E5 [F1] 不回归：初始 cwd 直接 run / 日常命令 / 非 run 族 cd", async () => {
  await withTempTree(async (root) => {
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { clean: "rimraf ~", lint: "oxlint" } }),
    );
    await writeFile(
      join(root, "sub", "package.json"),
      JSON.stringify({ scripts: { clean: "echo ok" } }),
    );
    assert.equal(
      await assessedWithPrefetch("npm run clean", root),
      "catastrophic",
      "初始 cwd 直接跑：body 危险照旧 catastrophic",
    );
    assert.equal(await assessedWithPrefetch("pnpm lint", root), "safe", "日常命令零摩擦");
    assert.equal(await assessedWithPrefetch("cd dist && rm -rf *", root), "low", "非 run 族 cd 行为不变");
  });
});

test("E6 [F1] executor 端到端：yolo + cd 进子包（body 灾难）→ deny", async () => {
  await withTempTree(async (root) => {
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { clean: "echo ok" } }));
    await writeFile(
      join(root, "sub", "package.json"),
      JSON.stringify({ scripts: { clean: "rimraf ~" } }),
    );
    const result = await resolveToolPermission(
      executorDeps(root),
      { id: "call-f1-e2e", name: "Bash", input: { command: "cd sub && npm run clean" } },
      bashToolEntry,
      { command: "cd sub && npm run clean" },
      {},
      "yolo",
      { traceId: "trace-f1" },
    );
    assert.equal(result.allowed, false, "预取注入子包 map → body catastrophic → yolo deny");
  });
});

test("E7 [F1②] 反射门链路：yolo + 覆盖证明缺失的 confirm 形态 → 门首轮 reflect deny", () => {
  const service = new PermissionService();
  const decision = service.checkPermission(
    {
      toolName: "Bash",
      input: { command: "cd sub && npm run clean" },
      riskLevel: "high",
      mode: "yolo",
      workingDirectory: PKG_DIR,
      workspaceRoot: PKG_DIR,
      sessionId: "session-f1-gate",
      // ①失效形态：只注入根包 map + 根目录覆盖证据（sub 未预取）——覆盖证明缺失
      // 的 confirm 必须经 scannedDirectories 一路透传到反射门，否则门内退回
      // enclosing 误判、yolo 静默 allow（这是透传链路存在的全部理由）。
      packageScripts: [{ directory: PKG_DIR, scripts: { clean: "echo ok" } }],
      scannedDirectories: [PKG_DIR],
    },
    CRITICAL_CAPABILITY,
  );
  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, "gate.bashConfirmReflex.reflect");
});

// ── F：对抗验证 F2（npx/npm exec 取值旗标） ──

test("F1 [F2] npx/npm exec 取值旗标缺口闭合：4+1 形态全部 catastrophic", () => {
  const cases = [
    "npx --package x npm run clean",
    'npx -c "npm run clean"',
    'npx --call "npm run clean"',
    "npm exec --package x -- rimraf ~",
    'npm exec -c "npm run clean"',
  ];
  for (const command of cases) {
    assert.equal(level(command, { clean: "rimraf ~" }), "catastrophic", `${command}`);
  }
});

test("F2 [F2] 保底网：解包停点后残留包管理器词 → confirm", () => {
  // 人为漏表形态（未收录旗标 + 后随包管理器词）：即使取值表再漂移也至少 confirm。
  assert.equal(level("npx --unknown-flag npm run clean", { clean: "rimraf ~" }), "catastrophic",
    "未知旗标后的 npm 进保底网 + run 族重解析，双保险");
});

test("F3 [F2] 不回归：npx 既有形态档位零变化", () => {
  assert.equal(level("npx tsc --noEmit", {}), "safe");
  assert.equal(level("npx rimraf dist", {}), "low");
  assert.equal(level("npx npm run clean", { clean: "rimraf ~" }), "catastrophic", "既有 catastrophic 不变");
  assert.equal(level("npx rimraf ~", {}), "catastrophic");
  assert.equal(level("npx --package=x rimraf ~", {}), "catastrophic", "= 粘连形既有 catastrophic 不变");
  assert.equal(level("npx pnpm lint", { lint: "oxlint" }), "safe", "完整再解包不受保底网误伤");
  assert.equal(level("bunx rimraf ~/.ssh", {}), "catastrophic");
  assert.equal(level("exec -c rimraf ~", {}), "catastrophic", "bash 内建 exec -c 是清环境，payload 照常分级");
});

// ── G：对抗验证 F3（xargs/管道位的无名 run 与 {} 名） ──

test("G1 [F3] xargs/管道位无名 run → confirm", () => {
  assert.equal(level("echo clean | xargs npm run", { clean: "rimraf ~" }), "confirm");
  assert.equal(level("xargs npm run < names.txt", { clean: "rimraf ~" }), "confirm");
  assert.equal(level("echo clean | npm run", { clean: "rimraf ~" }), "confirm", "管道直喂同理");
});

test("G2 [F3] xargs 位 {} 名 → confirm", () => {
  assert.equal(level("echo clean | xargs -I{} npm run {}", { clean: "rimraf ~" }), "confirm");
});

test("G3 [F3] 不回归：裸无名 run / 名可见 xargs / 管道喂 rm", () => {
  assert.equal(level("npm run", { clean: "rimraf ~" }), "safe", "裸无名（无管道）天然失败 → safe");
  assert.equal(level("yarn run", {}), "safe");
  assert.equal(level("xargs npm run clean", { clean: "rimraf ~" }), "catastrophic", "名可见 → body 照常评估");
  assert.equal(level("echo ~ | xargs rm -rf", {}), "confirm", "管道喂 rm 不变");
  assert.equal(level("echo clean | xargs pnpm lint", { lint: "oxlint" }), "safe", "有名 run 的管道位不受影响");
});

test("G4 [F3] fallback 口径：子壳内 xargs 无名 run 一层括号不降级", () => {
  assert.equal(level("(echo clean | xargs npm run)", { clean: "rimraf ~" }), "confirm");
});

// ── H：对抗验证 F4/F5/F6 ──

test("H1 [F4] 坏 JSON 止走：不用父包 map（过严误报修正）", async () => {
  await withTempTree(async (root) => {
    await mkdir(join(root, "broken"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { x: "rimraf ~" } }));
    await writeFile(join(root, "broken", "package.json"), "{ not json !!!");
    assert.equal(
      await assessedWithPrefetch("npm run x", join(root, "broken")),
      "safe",
      "npm 读到的是坏 JSON、命令天然失败 → 止走，不评父包同名 body",
    );
  });
});

test("H2 [F5] 粘连形 -C<path>/-F<path> 与空格形同判", async () => {
  await withTempTree(async (root) => {
    await mkdir(join(root, "packages", "x"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { lint: "oxlint" } }));
    await writeFile(
      join(root, "packages", "x", "package.json"),
      JSON.stringify({ scripts: { evil: "rimraf ~" } }),
    );
    const prefetchAndAssess = async (command) => {
      const prefetch = await collectBashPackageScriptSources(command, {
        workingDirectory: root,
        workspaceRoot: root,
      });
      return assessBashCommandTargetRisk(command, {
        workingDirectory: root,
        workspaceRoot: root,
        homeDirectory: homedir(),
        platform: process.platform,
        packageScripts: prefetch.sources,
        scannedDirectories: prefetch.scannedDirectories,
      }).level;
    };
    assert.equal(await prefetchAndAssess("pnpm -Cpackages/x run evil"), "catastrophic", "粘连形");
    assert.equal(await prefetchAndAssess("pnpm -C packages/x run evil"), "catastrophic", "空格形");
    assert.equal(await prefetchAndAssess("pnpm -F./packages/x run evil"), "catastrophic", "粘连 -F");
    assert.equal(await prefetchAndAssess("pnpm --filter ./packages/x run evil"), "catastrophic", "长旗标形");
  });
});

test("H3 [F6] main 缺失且无 --if-present → 跳过 pre/post（两方向）", () => {
  assert.equal(
    level("npm run nosuch", { clean: "rimraf ~", prenosuch: "rimraf ~", postnosuch: "rimraf ~" }),
    "safe",
    "npm 报 Missing script 退出、钩子不执行",
  );
  assert.equal(
    level("npm run nosuch --if-present", { clean: "rimraf ~", prenosuch: "rimraf ~" }),
    "catastrophic",
    "--if-present 语境 npm 真会跑 pre",
  );
  assert.equal(
    level("npm run nosuch --if-present", { clean: "rimraf ~", postnosuch: "rimraf ~" }),
    "catastrophic",
    "--if-present 语境 post 同理",
  );
  assert.equal(
    level("npm run build", { build: "echo ok", prebuild: "rm -rf /etc/passwd" }),
    "catastrophic",
    "main 存在时 pre 照旧评估（A3 不回归）",
  );
});

test("H4 [F7 登记] --prefix ./missing：ancestor 命中即评估祖先 body（过严方向登记）", async () => {
  await withTempTree(async (root) => {
    await mkdir(join(root, "missing"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { clean: "rimraf ~" } }));
    // 现口径（spec R2/F7）：npm --prefix 目标当项目根；选择器向上走在祖先读到包并
    // 注册 → 覆盖证明成立 → enclosing 信任 → 评祖先 body（过严方向、可接受）。
    assert.equal(await assessedWithPrefetch("npm --prefix ./missing run clean", root), "catastrophic");
  });
});
