import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentDiagnostic, ModelSelection } from "@acode/shared";
import {
  createSubagentsService,
  loadBundledAgentSummaries,
} from "../src/subagents/subagentsService.js";

/**
 * GUI 侧官方预置子智能体目录（spec: apps/acode-cli/specs/builtin-subagent-catalog.md R7）。
 * 覆盖验收场景 5/6/7 的 services 投影：list 合并顺序、bundled 只读姿态、禁用启停持久化、
 * 内置模型覆盖读写（含旧二键 state 兼容与未知键忽略）、root 缺省降级、保留名拒绝。
 */

const PLAN_ID = "built-in:built-in:plan";
const VERIFY_ID = "built-in:built-in:verify";
const REVIEW_ID = "built-in:built-in:review";
const EXPLORE_ID = "built-in:built-in:explore";

function bundledMarkdown(name: string, extra: string): string {
  return `---
name: ${name}
description: Bundled ${name} agent for catalog tests.
${extra}---

You are ${name}. Fixture prompt body for GUI projection tests.
`;
}

async function writeBundledRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "Plan.md"),
    bundledMarkdown("Plan", "tools:\n  - Read\n  - Grep\npermissionMode: plan\ncolor: purple\n"),
    "utf-8",
  );
  await writeFile(
    join(root, "Verify.md"),
    bundledMarkdown(
      "Verify",
      "tools:\n  - Bash\n  - Read\ndisallowedTools:\n  - Edit\n  - Write\ncolor: green\nbackground: true\n",
    ),
    "utf-8",
  );
  await writeFile(
    join(root, "Review.md"),
    bundledMarkdown("Review", "tools:\n  - Read\npermissionMode: plan\ncolor: yellow\n"),
    "utf-8",
  );
}

async function createFixture(): Promise<{
  home: string;
  workspace: string;
  bundledRoot: string;
  stateFile: string;
}> {
  const home = await mkdtemp(join(tmpdir(), "acode-bundled-agents-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "acode-bundled-agents-ws-"));
  const bundledRoot = join(home, "pack", "agents");
  await writeBundledRoot(bundledRoot);

  const userAgentsDir = join(home, ".acode", "agents");
  await mkdir(userAgentsDir, { recursive: true });
  await writeFile(
    join(userAgentsDir, "note-taker.md"),
    "---\nname: note-taker\ndescription: Takes notes.\n---\n\nTake notes.\n",
    "utf-8",
  );
  const workspaceAgentsDir = join(workspace, ".acode", "agents");
  await mkdir(workspaceAgentsDir, { recursive: true });
  await writeFile(
    join(workspaceAgentsDir, "ws-helper.md"),
    "---\nname: ws-helper\ndescription: Workspace helper.\n---\n\nHelp.\n",
    "utf-8",
  );

  return {
    home,
    workspace,
    bundledRoot,
    stateFile: join(home, ".acode", "v2", "agents-state.json"),
  };
}

function createService(fixture: { home: string; bundledRoot?: string }) {
  return createSubagentsService({
    homeDir: fixture.home,
    isDesktopRuntime: true,
    bundledAgentsRoot: fixture.bundledRoot,
  });
}

test("list 合并顺序：核心内置 → bundled → user → workspace，bundled 为只读预置投影", async () => {
  const fixture = await createFixture();
  const service = createService({ home: fixture.home, bundledRoot: fixture.bundledRoot });
  const result = await service.list({ workspacePath: fixture.workspace });

  assert.deepEqual(
    result.agents.map((agent) => agent.name),
    ["general-purpose", "Explore", "Plan", "Review", "Verify", "note-taker", "ws-helper"],
  );

  const plan = result.agents.find((agent) => agent.name === "Plan");
  assert.ok(plan);
  assert.equal(plan.source, "built-in");
  assert.equal(plan.scope, "built-in");
  // path 是展示别名，不暴露包内真实文件路径（R7）。
  assert.equal(plan.path, "bundled:Plan");
  assert.equal(plan.readOnly, true);
  assert.equal(plan.enabled, true);
  assert.equal(plan.id, PLAN_ID);
  assert.deepEqual(plan.tools, ["Read", "Grep"]);
  assert.equal(plan.permissionMode, "plan");

  const verify = result.agents.find((agent) => agent.name === "Verify");
  assert.ok(verify);
  assert.deepEqual(verify.disallowedTools, ["Edit", "Write"]);
  assert.equal(verify.background, true);
});

test("settingsUserOnly 模式同样含 bundled，排在核心内置后、user 前", async () => {
  const fixture = await createFixture();
  const service = createService({ home: fixture.home, bundledRoot: fixture.bundledRoot });
  const result = await service.list({
    workspacePath: fixture.workspace,
    mode: "settingsUserOnly",
  });

  assert.deepEqual(
    result.agents.map((agent) => agent.name),
    ["general-purpose", "Explore", "Plan", "Review", "Verify", "note-taker"],
  );
});

test("user 同名 markdown 覆盖 bundled 成员（R5 覆盖序在 GUI 投影一致）", async () => {
  const fixture = await createFixture();
  await writeFile(
    join(fixture.home, ".acode", "agents", "plan.md"),
    "---\nname: Plan\ndescription: User override of Plan.\n---\n\nUser body.\n",
    "utf-8",
  );
  const service = createService({ home: fixture.home, bundledRoot: fixture.bundledRoot });
  const result = await service.list({ workspacePath: fixture.workspace });

  const planEntries = result.agents.filter((agent) => agent.name === "Plan");
  assert.equal(planEntries.length, 1);
  assert.equal(planEntries[0]?.source, "user");
  assert.equal(planEntries[0]?.description, "User override of Plan.");
});

test("updateAgent/deleteAgent 对 bundled 与核心内置成员抛错（readOnly，R7）", async () => {
  const fixture = await createFixture();
  const service = createService({ home: fixture.home, bundledRoot: fixture.bundledRoot });

  await assert.rejects(
    () =>
      service.deleteAgent({
        agentId: PLAN_ID,
        filePath: "bundled:Plan",
      }),
    /read-only/iu,
  );
  await assert.rejects(
    () =>
      service.deleteAgent({
        agentId: EXPLORE_ID,
        filePath: "built-in:Explore",
      }),
    /read-only/iu,
  );
  await assert.rejects(
    () =>
      service.updateAgent({
        agentId: PLAN_ID,
        provider: "glm",
        oldFilePath: "bundled:Plan",
        config: {
          name: "plan-editor",
          description: "Should not reach disk.",
          systemPrompt: "Should not reach disk.",
        },
      }),
    /read-only/iu,
  );
  // 保留名拒绝先于路径守卫：直接改名 Plan 同样被拒。
  await assert.rejects(
    () =>
      service.updateAgent({
        agentId: "user:user:note-taker",
        provider: "glm",
        config: {
          name: "Plan",
          description: "Should not reach disk.",
          systemPrompt: "Should not reach disk.",
        },
      }),
    /reserved/iu,
  );
});

test("createAgent 保留名拒绝含 Plan/Verify/Review（不依赖 bundledAgentsRoot 接线）", async () => {
  const fixture = await createFixture();
  const service = createService({ home: fixture.home });

  for (const name of ["general-purpose", "Explore", "Plan", "Verify", "Review"]) {
    await assert.rejects(
      () =>
        service.createAgent({
          provider: "glm",
          config: {
            name,
            description: "Reserved name probe.",
            systemPrompt: "Reserved name probe.",
          },
        }),
      /reserved/iu,
      `createAgent 应拒绝保留名 ${name}`,
    );
  }

  const created = await service.createAgent({
    provider: "glm",
    config: {
      name: "my-agent",
      description: "Not reserved.",
      systemPrompt: "Do things.",
    },
  });
  assert.equal(created.agent.name, "my-agent");
});

test("禁用 bundled 成员：enabled=false 持久化到 agents-state.json，重新启用恢复；核心内置恒 enabled", async () => {
  const fixture = await createFixture();
  const service = createService({ home: fixture.home, bundledRoot: fixture.bundledRoot });

  await service.setEnabled({ agentId: VERIFY_ID, enabled: false });
  const stateAfterDisable = JSON.parse(await readFile(fixture.stateFile, "utf-8")) as {
    disabledAgentIds: string[];
  };
  assert.deepEqual(stateAfterDisable.disabledAgentIds, [VERIFY_ID]);

  const disabledList = await service.list({ workspacePath: fixture.workspace });
  const verify = disabledList.agents.find((agent) => agent.name === "Verify");
  assert.ok(verify);
  assert.equal(verify.enabled, false);
  // 其余成员不受影响。
  for (const name of ["general-purpose", "Explore", "Plan", "Review"]) {
    const agent = disabledList.agents.find((item) => item.name === name);
    assert.equal(agent?.enabled, true, `${name} 应保持 enabled`);
  }

  await service.setEnabled({ agentId: VERIFY_ID, enabled: true });
  const stateAfterEnable = JSON.parse(await readFile(fixture.stateFile, "utf-8")) as {
    disabledAgentIds: string[];
  };
  assert.deepEqual(stateAfterEnable.disabledAgentIds, []);
  const enabledList = await service.list({ workspacePath: fixture.workspace });
  assert.equal(enabledList.agents.find((agent) => agent.name === "Verify")?.enabled, true);

  // 核心二内置无开关：即使 state 里被写入其 id，list 仍恒 enabled。
  await writeFile(
    fixture.stateFile,
    JSON.stringify({
      builtInModelSelectionOverrides: {},
      pluginAgentModelSelectionOverrides: {},
      disabledAgentIds: [EXPLORE_ID, "built-in:built-in:general-purpose"],
    }),
    "utf-8",
  );
  const forcedList = await service.list({ workspacePath: fixture.workspace });
  assert.equal(forcedList.agents.find((agent) => agent.name === "Explore")?.enabled, true);
  assert.equal(forcedList.agents.find((agent) => agent.name === "general-purpose")?.enabled, true);
});

test("模型覆盖：bundled 成员读 builtInModelSelectionOverrides，未知键忽略，旧二键 state 兼容，写入按联合键持久化", async () => {
  const fixture = await createFixture();
  const reviewSelection: ModelSelection = { providerId: "zai", modelId: "glm-review" };
  // 旧 state 文件：仅二键 + 一个未知键（模拟历史版本或损坏数据），加载不得报错。
  await mkdir(join(fixture.home, ".acode", "v2"), { recursive: true });
  await writeFile(
    fixture.stateFile,
    JSON.stringify({
      builtInModelSelectionOverrides: {
        Explore: { providerId: "zai", modelId: "glm-explore" },
        Review: reviewSelection,
        "Legacy-Agent": { providerId: "legacy", modelId: "gone" },
      },
      pluginAgentModelSelectionOverrides: {},
      disabledAgentIds: [],
    }),
    "utf-8",
  );

  const service = createService({ home: fixture.home, bundledRoot: fixture.bundledRoot });
  const result = await service.list({ workspacePath: fixture.workspace });
  const review = result.agents.find((agent) => agent.name === "Review");
  assert.ok(review);
  assert.equal(review.id, REVIEW_ID);
  assert.deepEqual(review.modelSelection, reviewSelection);
  assert.deepEqual(review.modelSelectionOverride, reviewSelection);
  const explore = result.agents.find((agent) => agent.name === "Explore");
  assert.deepEqual(explore?.modelSelection, { providerId: "zai", modelId: "glm-explore" });
  assert.ok(
    !result.agents.some((agent) => agent.name === "Legacy-Agent"),
    "未知覆盖键不得伪造条目",
  );

  // GUI 写通道：给 Verify 设模型 → 持久化；未知键在重写后被丢弃，已知键保留。
  const verifySelection: ModelSelection = { providerId: "zai", modelId: "glm-verify" };
  await service.setBuiltInModelOverride({ agentName: "Verify", modelSelection: verifySelection });
  const state = JSON.parse(await readFile(fixture.stateFile, "utf-8")) as {
    builtInModelSelectionOverrides: Record<string, ModelSelection>;
  };
  assert.deepEqual(state.builtInModelSelectionOverrides.Verify, verifySelection);
  assert.deepEqual(state.builtInModelSelectionOverrides.Review, reviewSelection);
  assert.equal(state.builtInModelSelectionOverrides["Legacy-Agent"], undefined);

  // 清除覆盖（modelSelection undefined）→ 键被删除。
  await service.setBuiltInModelOverride({ agentName: "Verify", modelSelection: undefined });
  const cleared = JSON.parse(await readFile(fixture.stateFile, "utf-8")) as {
    builtInModelSelectionOverrides: Record<string, ModelSelection>;
  };
  assert.equal(cleared.builtInModelSelectionOverrides.Verify, undefined);
});

test("root 缺省/不存在：list 不含 bundled、不报错；loadBundledAgentSummaries 返回空数组", async () => {
  const fixture = await createFixture();

  const withoutRoot = createService({ home: fixture.home });
  const result = await withoutRoot.list({ workspacePath: fixture.workspace });
  assert.deepEqual(
    result.agents.map((agent) => agent.name),
    ["general-purpose", "Explore", "note-taker", "ws-helper"],
  );
  assert.ok(!result.agents.some((agent) => agent.path.startsWith("bundled:")));

  const missingRoot = createService({
    home: fixture.home,
    bundledRoot: join(fixture.home, "no-such-pack", "agents"),
  });
  const missingResult = await missingRoot.list({ workspacePath: fixture.workspace });
  assert.ok(!missingResult.agents.some((agent) => agent.path.startsWith("bundled:")));

  assert.deepEqual(await loadBundledAgentSummaries(undefined), []);
  assert.deepEqual(await loadBundledAgentSummaries("   "), []);
  assert.deepEqual(
    await loadBundledAgentSummaries(join(fixture.home, "no-such-pack", "agents")),
    [],
  );
});

test("bundled markdown 损坏：坏文件不装配、diagnostic 上报，好文件照常列出（R8 不静默）", async () => {
  const fixture = await createFixture();
  await writeFile(join(fixture.bundledRoot, "Broken.md"), "no frontmatter at all\n", "utf-8");

  const diagnostics: AgentDiagnostic[] = [];
  const agents = await loadBundledAgentSummaries(fixture.bundledRoot, { diagnostics });
  assert.deepEqual(
    agents.map((agent) => agent.name),
    ["Plan", "Review", "Verify"],
  );
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.code, "agent_missing_frontmatter");
  assert.ok(diagnostics[0]?.path?.endsWith("Broken.md"));

  // list 通道同样把 diagnostic 带出，而不是吞掉。
  const service = createService({ home: fixture.home, bundledRoot: fixture.bundledRoot });
  const result = await service.list({ workspacePath: fixture.workspace });
  assert.ok((result.diagnostics ?? []).some((item) => item.code === "agent_missing_frontmatter"));
});

test("loadBundledAgentSummaries：enabled 随 disabledAgentIds，模型覆盖取 builtInModelSelectionOverrides", async () => {
  const fixture = await createFixture();
  const reviewSelection: ModelSelection = { providerId: "zai", modelId: "glm-review" };
  const agents = await loadBundledAgentSummaries(fixture.bundledRoot, {
    disabledAgentIds: [VERIFY_ID],
    modelSelectionOverrides: { Review: reviewSelection },
  });

  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  assert.equal(byName.get("Verify")?.enabled, false);
  assert.equal(byName.get("Plan")?.enabled, true);
  assert.equal(byName.get("Review")?.enabled, true);
  assert.deepEqual(byName.get("Review")?.modelSelection, reviewSelection);
  assert.deepEqual(byName.get("Review")?.modelSelectionOverride, reviewSelection);
  for (const agent of agents) {
    assert.equal(agent.source, "built-in");
    assert.equal(agent.scope, "built-in");
    assert.equal(agent.readOnly, true);
    assert.ok(agent.path.startsWith("bundled:"));
  }
});
