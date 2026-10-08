import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { createSubagentsService } from "../src/subagents/subagentsService.js";

/**
 * M9 修复守护：subagentsService.deleteAgent/updateAgent 的 rm 目标收口。
 * 根因：filePath/oldFilePath 是 RPC 裸 string，原实现直接 rm(force:true)——被攻破的
 * 客户端可删除任意路径；唯一防护 isBuiltInAgentAliasPath 只挡展示别名。
 * spec: packages/services/specs/service-fs-path-confinement.md R4。
 */

const VALID_CONFIG = {
  description: "Confinement fixture agent.",
  systemPrompt: "Do fixture things.",
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function createFixture() {
  const home = await mkdtemp(join(tmpdir(), "acode-subagents-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "acode-subagents-ws-"));
  const victimDir = await mkdtemp(join(tmpdir(), "acode-subagents-victim-"));
  const userAgentsDir = join(home, ".acode", "agents");
  await mkdir(userAgentsDir, { recursive: true });
  const service = createSubagentsService({ homeDir: home, isDesktopRuntime: true });
  return { home, workspace, victimDir, userAgentsDir, service };
}

test("deleteAgent：用户级受控根内 agent 照常删除", async () => {
  const fixture = await createFixture();
  const { agent } = await fixture.service.createAgent({
    provider: "glm",
    config: { name: "fixture-agent", ...VALID_CONFIG },
  });
  assert.equal(agent.path, join(fixture.userAgentsDir, "fixture-agent.md"));
  assert.equal(await exists(agent.path), true);

  await fixture.service.deleteAgent({ agentId: agent.id, filePath: agent.path });
  assert.equal(await exists(agent.path), false);
});

test("deleteAgent：受控根外任意路径拒绝且目标原样保留", async () => {
  const fixture = await createFixture();
  const victimFile = join(fixture.victimDir, "victim.md");
  await writeFile(victimFile, "VICTIM", "utf-8");

  await assert.rejects(
    () => fixture.service.deleteAgent({ agentId: "user:user:any", filePath: victimFile }),
    /outside managed agent directories/iu,
  );
  assert.equal(await exists(victimFile), true);
});

test('deleteAgent：".." 穿越路径拒绝（原始未规范化字符串）', async () => {
  const fixture = await createFixture();
  const victimFile = join(fixture.home, "home-victim.md");
  await writeFile(victimFile, "VICTIM", "utf-8");
  const traversal = `${fixture.userAgentsDir}/../home-victim.md`;

  await assert.rejects(
    () => fixture.service.deleteAgent({ agentId: "user:user:any", filePath: traversal }),
    /outside managed agent directories/iu,
  );
  assert.equal(await exists(victimFile), true);
});

test("deleteAgent：项目级 agent 按结构兜底允许；.acode/agents 之外拒绝", async () => {
  const fixture = await createFixture();
  const workspaceAgentsDir = join(fixture.workspace, ".acode", "agents");
  await mkdir(workspaceAgentsDir, { recursive: true });
  const workspaceAgentFile = join(workspaceAgentsDir, "ws-agent.md");
  await writeFile(
    workspaceAgentFile,
    "---\nname: ws-agent\ndescription: d\n---\n\nbody\n",
    "utf-8",
  );

  await fixture.service.deleteAgent({
    agentId: "workspace:workspace:ws-agent",
    filePath: workspaceAgentFile,
  });
  assert.equal(await exists(workspaceAgentFile), false, "项目级 agent 文件应可删除");

  // workspace 内、agents 目录外的文件不可删除。
  const workspaceSecret = join(fixture.workspace, "secret.md");
  await writeFile(workspaceSecret, "SECRET", "utf-8");
  await assert.rejects(
    () =>
      fixture.service.deleteAgent({
        agentId: "workspace:workspace:any",
        filePath: `${workspaceAgentsDir}/../../secret.md`,
      }),
    /outside managed agent directories/iu,
  );
  assert.equal(await exists(workspaceSecret), true);
});

test("deleteAgent：受控根内不存在的目标保持幂等（absent no-op，状态清理照常）", async () => {
  const fixture = await createFixture();
  await fixture.service.deleteAgent({
    agentId: "user:user:gone-agent",
    filePath: join(fixture.userAgentsDir, "gone-agent.md"),
  });
  // 幂等清理仍写回状态文件。
  assert.equal(await exists(join(fixture.home, ".acode", "v2", "agents-state.json")), true);
});

test("updateAgent：用户级改名照常，旧文件被删除", async () => {
  const fixture = await createFixture();
  const { agent } = await fixture.service.createAgent({
    provider: "glm",
    config: { name: "rename-me", ...VALID_CONFIG },
  });

  const updated = await fixture.service.updateAgent({
    agentId: agent.id,
    provider: "glm",
    oldFilePath: agent.path,
    config: { name: "renamed-ok", ...VALID_CONFIG },
  });
  assert.equal(updated.agent.path, join(fixture.userAgentsDir, "renamed-ok.md"));
  assert.equal(await exists(updated.agent.path), true);
  assert.equal(await exists(agent.path), false, "旧文件应被删除");
});

test("updateAgent：越界 oldFilePath 拒绝，写盘前失败且任意文件不被删除", async () => {
  const fixture = await createFixture();
  const victimFile = join(fixture.victimDir, "update-victim.md");
  await writeFile(victimFile, "VICTIM", "utf-8");

  await assert.rejects(
    () =>
      fixture.service.updateAgent({
        agentId: "user:user:any",
        provider: "glm",
        oldFilePath: victimFile,
        config: { name: "should-not-exist", ...VALID_CONFIG },
      }),
    /outside managed agent directories/iu,
  );
  assert.equal(await exists(victimFile), true, "越界旧文件必须原样保留");
  assert.equal(
    await exists(join(fixture.userAgentsDir, "should-not-exist.md")),
    false,
    "拒绝必须发生在新文件写盘之前",
  );
});

test("updateAgent：workspace scope 在 resolveWorkspaceSubagentRoot 内改名照常", async () => {
  const fixture = await createFixture();
  const workspaceAgentsDir = join(fixture.workspace, ".acode", "agents");
  await mkdir(workspaceAgentsDir, { recursive: true });
  const oldPath = join(workspaceAgentsDir, "ws-rename.md");
  await writeFile(oldPath, "---\nname: ws-rename\ndescription: d\n---\n\nbody\n", "utf-8");

  const updated = await fixture.service.updateAgent({
    agentId: "workspace:workspace:ws-rename",
    provider: "glm",
    scope: "workspace",
    workspacePath: fixture.workspace,
    oldFilePath: oldPath,
    config: { name: "ws-renamed", ...VALID_CONFIG },
  });
  assert.equal(updated.agent.path, join(workspaceAgentsDir, "ws-renamed.md"));
  assert.equal(await exists(updated.agent.path), true);
  assert.equal(await exists(oldPath), false);
});

test("updateAgent：workspace scope 下指向根外的 oldFilePath 拒绝", async () => {
  const fixture = await createFixture();
  const workspaceAgentsDir = join(fixture.workspace, ".acode", "agents");
  await mkdir(workspaceAgentsDir, { recursive: true });
  const victimFile = join(fixture.victimDir, "ws-victim.md");
  await writeFile(victimFile, "VICTIM", "utf-8");

  await assert.rejects(
    () =>
      fixture.service.updateAgent({
        agentId: "workspace:workspace:any",
        provider: "glm",
        scope: "workspace",
        workspacePath: fixture.workspace,
        // 用 workspace 根内前缀拼接穿越段（agents→.acode→ws→tmpdir），指向根外受害文件。
        oldFilePath: `${workspaceAgentsDir}/../../../${basename(fixture.victimDir)}/ws-victim.md`,
        config: { name: "ws-should-not-exist", ...VALID_CONFIG },
      }),
    /outside managed agent directories/iu,
  );
  assert.equal(await readFile(victimFile, "utf-8"), "VICTIM");
});

test("updateAgent：oldFilePath 软链异拼写指向同一文件时不产生破坏性删除", async (t) => {
  const fixture = await createFixture();
  const { agent } = await fixture.service.createAgent({
    provider: "glm",
    config: { name: "alias-target", ...VALID_CONFIG },
  });
  const linkPath = join(fixture.userAgentsDir, "alias-link.md");
  try {
    await symlink(agent.path, linkPath);
  } catch {
    t.skip("当前平台/权限不支持创建文件软链，跳过异拼写用例");
    return;
  }

  // 同名更新 + 软链异拼写：raw 比较不相等，存在性检查先于写盘拒绝（现状行为）；
  // 关键是目标文件与软链都不得被删除。写后再删同一文件的竞态窗口由 rm 前的
  // canonical 比较兜底（见 subagentsService.updateAgent 内注释）。
  const originalContent = await readFile(agent.path, "utf-8");
  await assert.rejects(
    () =>
      fixture.service.updateAgent({
        agentId: agent.id,
        provider: "glm",
        oldFilePath: linkPath,
        config: { name: "alias-target", ...VALID_CONFIG },
      }),
    /already exists/iu,
  );
  assert.equal(await readFile(agent.path, "utf-8"), originalContent, "目标文件必须原样保留");
  assert.ok(await lstat(linkPath).catch(() => null), "软链目录项必须保留");

  // 改名 + 软链异拼写：正常 rename 语义——新文件写入、旧目标文件删除、软链变悬空。
  const renamed = await fixture.service.updateAgent({
    agentId: agent.id,
    provider: "glm",
    oldFilePath: linkPath,
    config: { name: "alias-renamed", ...VALID_CONFIG },
  });
  assert.equal(renamed.agent.path, join(fixture.userAgentsDir, "alias-renamed.md"));
  assert.equal(await exists(renamed.agent.path), true, "改名后的新文件应存在");
  assert.equal(await exists(agent.path), false, "旧目标文件应随改名被删除");
});

test("deleteAgent/updateAgent：built-in 与 bundled 别名仍先行拒绝（既有只读语义不回归）", async () => {
  const fixture = await createFixture();
  await assert.rejects(
    () =>
      fixture.service.deleteAgent({
        agentId: "built-in:built-in:explore",
        filePath: "built-in:Explore",
      }),
    /read-only/iu,
  );
  await assert.rejects(
    () =>
      fixture.service.deleteAgent({ agentId: "built-in:built-in:plan", filePath: "bundled:Plan" }),
    /read-only/iu,
  );
  await assert.rejects(
    () =>
      fixture.service.updateAgent({
        agentId: "built-in:built-in:plan",
        provider: "glm",
        oldFilePath: "bundled:Plan",
        config: { name: "plan-editor", ...VALID_CONFIG },
      }),
    /read-only/iu,
  );
});
