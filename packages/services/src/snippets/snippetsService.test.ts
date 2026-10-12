import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PROMPT_SNIPPET_MAX_USE_COUNT, PROMPT_SNIPPET_GLOBAL_WORKSPACE_KEY } from "@acode/shared";
import { SnippetsRepo } from "./snippetsRepo.js";
import { createSnippetsService } from "./snippetsService.js";

// 真实 DB + 临时目录：迁移 0005、唯一索引、自增语义都在这里守住。

async function withService(
  run: (service: ReturnType<typeof createSnippetsService>, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "snippets-service-"));
  const repo = new SnippetsRepo(join(dir, "tasks-index.sqlite"));
  const service = createSnippetsService({ repo });
  try {
    await run(service, dir);
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const workspace = { workspacePath: "/ws/a" };

test("创建后可按 workspaceKey 列出", async () => {
  await withService(async (service) => {
    const created = await service.create({
      ...workspace,
      name: "代码审查",
      category: "审查",
      content: "请审查以下 {{语言}} 代码。",
      kind: "prompt",
    });
    assert.match(created.snippetId, /^snp_[0-9a-f]{12}$/);
    assert.equal(created.workspaceKey, "/ws/a");
    assert.equal(created.useCount, 0);
    assert.equal(created.lastUsedAt, null);

    const result = await service.list(workspace);
    assert.equal(result.snippets.length, 1);
    assert.equal(result.snippets[0]?.name, "代码审查");
  });
});

test("workspaceIdentity 优先于 workspacePath 作为 workspaceKey", async () => {
  await withService(async (service) => {
    const created = await service.create({
      workspacePath: "/ws/a",
      workspaceIdentity: "remote:abc",
      name: "x",
      category: "",
      content: "c",
      kind: "prompt",
    });
    assert.equal(created.workspaceKey, "remote:abc");
    assert.equal(
      (await service.list({ workspacePath: "/ws/a", workspaceIdentity: "remote:abc" })).snippets
        .length,
      1,
    );
    assert.equal((await service.list({ workspacePath: "/ws/other" })).snippets.length, 0);
  });
});

test("同名（忽略大小写与首尾空白）拒绝创建", async () => {
  await withService(async (service) => {
    await service.create({
      ...workspace,
      name: "Code Review",
      category: "",
      content: "a",
      kind: "prompt",
    });
    await assert.rejects(
      service.create({
        ...workspace,
        name: "  code review  ",
        category: "",
        content: "b",
        kind: "prompt",
      }),
      /snippets\.error\.duplicateName/,
    );
    assert.equal((await service.list(workspace)).snippets.length, 1);
  });
});

test("更新不覆盖 use_count 与 last_used_at", async () => {
  await withService(async (service) => {
    const created = await service.create({
      ...workspace,
      name: "旧名",
      category: "",
      content: "a",
      kind: "prompt",
    });
    await service.recordUse({ snippetId: created.snippetId, builtin: false });
    await service.recordUse({ snippetId: created.snippetId, builtin: false });

    const updated = await service.update({
      snippetId: created.snippetId,
      name: "代码审查 v2",
      category: "审查",
      content: "b",
      kind: "prompt",
    });
    assert.equal(updated.name, "代码审查 v2");
    assert.equal(updated.useCount, 2);
    assert.notEqual(updated.lastUsedAt, null);
    assert.equal(updated.createdAt, created.createdAt);
  });
});

test("更新时与其他片段同名被拒绝", async () => {
  await withService(async (service) => {
    await service.create({ ...workspace, name: "A", category: "", content: "a", kind: "prompt" });
    const second = await service.create({
      ...workspace,
      name: "B",
      category: "",
      content: "b",
      kind: "prompt",
    });
    await assert.rejects(
      service.update({
        snippetId: second.snippetId,
        name: "a",
        category: "",
        content: "b",
        kind: "prompt",
      }),
      /snippets\.error\.duplicateName/,
    );
  });
});

test("删除不存在的 id 返回成功", async () => {
  await withService(async (service) => {
    await service.delete({ snippetId: "snp_does_not_exist" });
  });
});

test("删除后不再列出", async () => {
  await withService(async (service) => {
    const created = await service.create({
      ...workspace,
      name: "A",
      category: "",
      content: "a",
      kind: "prompt",
    });
    await service.delete({ snippetId: created.snippetId });
    assert.equal((await service.list(workspace)).snippets.length, 0);
  });
});

test("use_count 自增", async () => {
  await withService(async (service) => {
    const created = await service.create({
      ...workspace,
      name: "A",
      category: "",
      content: "a",
      kind: "prompt",
    });
    await service.recordUse({ snippetId: created.snippetId, builtin: false });
    await service.recordUse({ snippetId: created.snippetId, builtin: false });
    const row = (await service.list(workspace)).snippets[0];
    assert.equal(row?.useCount, 2);
    assert.notEqual(row?.lastUsedAt, null);
  });
});

test("use_count 达到 SQLite 上限后不再自增但更新 last_used_at", async () => {
  const dir = await mkdtemp(join(tmpdir(), "snippets-usage-cap-"));
  const dbPath = join(dir, "tasks-index.sqlite");
  const repo = new SnippetsRepo(dbPath);
  const reopenedRepo = new SnippetsRepo(dbPath);
  try {
    const service = createSnippetsService({ repo });
    const created = await service.create({
      ...workspace,
      name: "A",
      category: "",
      content: "a",
      kind: "prompt",
    });
    // 直接顶到上限，避免 21 亿次自增；用独立连接写，走的是同一份 SQLite 事实源。
    await repo.ensureReady();
    repo.close();
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(dbPath);
    raw
      .prepare("UPDATE snippets SET use_count = ? WHERE snippet_id = ?")
      .run(PROMPT_SNIPPET_MAX_USE_COUNT, created.snippetId);
    raw.close();

    const reopened = createSnippetsService({ repo: reopenedRepo });
    await reopened.recordUse({ snippetId: created.snippetId, builtin: false });
    const row = (await reopened.list(workspace)).snippets[0];
    assert.equal(row?.useCount, PROMPT_SNIPPET_MAX_USE_COUNT);
    assert.notEqual(row?.lastUsedAt, null);
  } finally {
    repo.close();
    reopenedRepo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("workspace_key = __global__ 的片段在任何工作区可见", async () => {
  const dir = await mkdtemp(join(tmpdir(), "snippets-global-"));
  const repo = new SnippetsRepo(join(dir, "tasks-index.sqlite"));
  try {
    await repo.ensureReady();
    await repo.insert({
      snippetId: "snp_global000001",
      workspaceKey: PROMPT_SNIPPET_GLOBAL_WORKSPACE_KEY,
      name: "全局片段",
      category: "",
      content: "g",
      kind: "prompt",
      now: Date.now(),
    });
    const service = createSnippetsService({ repo });
    assert.equal((await service.list({ workspacePath: "/ws/a" })).snippets.length, 1);
    assert.equal((await service.list({ workspacePath: "/ws/b" })).snippets.length, 1);
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("内置条目计数落在独立表且按 builtin 标志分流", async () => {
  const dir = await mkdtemp(join(tmpdir(), "snippets-builtin-usage-"));
  const repo = new SnippetsRepo(join(dir, "tasks-index.sqlite"));
  try {
    await repo.ensureReady();
    const service = createSnippetsService({ repo });
    await service.recordUse({ snippetId: "builtin:discipline:no-hands", builtin: true });
    await service.recordUse({ snippetId: "builtin:discipline:no-hands", builtin: true });
    const usage = await repo.listBuiltinUsage();
    assert.equal(usage.length, 1);
    assert.equal(usage[0]?.useCount, 2);
    assert.notEqual(usage[0]?.lastUsedAt, null);
    // 用户片段表不受影响。
    assert.equal((await service.list({ workspacePath: "/ws/a" })).snippets.length, 0);
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("校验失败不落库", async () => {
  await withService(async (service) => {
    await assert.rejects(
      service.create({ ...workspace, name: "  ", category: "", content: "a", kind: "prompt" }),
      /snippets\.invalid\.nameRequired/,
    );
    await assert.rejects(
      service.create({ ...workspace, name: "a", category: "", content: "  ", kind: "prompt" }),
      /snippets\.invalid\.contentRequired/,
    );
    await assert.rejects(
      service.create({
        ...workspace,
        name: "a".repeat(61),
        category: "",
        content: "a",
        kind: "prompt",
      }),
      /snippets\.invalid\.nameTooLong/,
    );
    assert.equal((await service.list(workspace)).snippets.length, 0);
  });
});
