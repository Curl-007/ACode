import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * TTL 持久授权存储（specs/mcp-lifecycle-ttl-approval.md R4）验收测试：
 * 期限解析与夹紧、过期回落、带版本落盘与迁移（fail-closed）、作用域、去重、
 * PermissionUpdate 折算（无人值守默认限期）。
 *
 * 全部使用 mkdtemp 临时目录，绝不触碰真实数据根。
 */

const {
  TtlApprovalStore,
  defaultTtlApprovalFilePath,
  DEFAULT_UNATTENDED_TTL_DAYS,
  MAX_UNATTENDED_TTL_DAYS,
  DEFAULT_MAX_TTL_DAYS,
} = await import("../packages/core/src/permission/ttl-approvals.ts");
const { parseTtlPermissionGrantFile } = await import(
  "../packages/core/src/permission/ttl-approval-file.ts"
);

const DAY_MS = 86_400_000;

async function withStore(options, fn) {
  const dir = mkdtempSync(join(tmpdir(), "acode-ttl-approval-"));
  try {
    const warnings = [];
    const state = { now: 1_700_000_000_000 };
    const store = await TtlApprovalStore.create({
      filePath: join(dir, "ttl-approvals.json"),
      now: () => state.now,
      warn: (message, details) => warnings.push({ message, details }),
      ...options,
    });
    return await fn({ store, state, warnings, dir, filePath: join(dir, "ttl-approvals.json") });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("交互式授权必须显式给期限；无人值守默认 7 天、上限 30 天", async () => {
  await withStore({}, async ({ store, state }) => {
    assert.throws(
      () => store.grant({ toolName: "Bash", origin: "interactive" }),
      /requires expiresAt or ttlDays/,
      "永久 allow 属于项目规则路径，TTL 存储不收无期限的交互批准",
    );

    const unattended = store.grant({ toolName: "mcp__srv__send", origin: "unattended" });
    assert.equal(DEFAULT_UNATTENDED_TTL_DAYS, 7);
    const expected = new Date(state.now + 7 * DAY_MS).toISOString();
    assert.equal(unattended.expiresAt, expected);

    const clamped = store.grant({
      toolName: "mcp__srv__long",
      origin: "unattended",
      ttlDays: 90,
    });
    assert.equal(MAX_UNATTENDED_TTL_DAYS, 30);
    assert.equal(clamped.expiresAt, new Date(state.now + 30 * DAY_MS).toISOString());

    const interactive = store.grant({ toolName: "WebFetch", origin: "interactive", ttlDays: 10 });
    assert.equal(interactive.expiresAt, new Date(state.now + 10 * DAY_MS).toISOString());
    assert.equal(interactive.grantedAt, new Date(state.now).toISOString());
    assert.equal(interactive.origin, "interactive");
    assert.ok(interactive.grantId);
  });
});

test("过期授权从 active 集合消失（回落 ask 的存储侧事实）", async () => {
  await withStore({}, async ({ store, state }) => {
    store.grant({ toolName: "Bash", ruleContent: "git status", origin: "interactive", ttlDays: 1 });
    const active = store.activeAllowRuleset();
    assert.deepEqual(active.allow, [{ toolName: "Bash", ruleContent: "git status" }]);

    state.now += DAY_MS + 1;
    assert.equal(store.activeAllowRuleset(), undefined);
    assert.deepEqual(store.listActive(), []);
  });
});

test("已过期时刻的授予直接拒绝（不记出生即死的授权）", async () => {
  await withStore({}, async ({ store, state }) => {
    assert.throws(
      () =>
        store.grant({
          toolName: "Bash",
          origin: "interactive",
          expiresAt: new Date(state.now - 1000).toISOString(),
        }),
      /already in the past/,
    );
  });
});

test("落盘带版本号、原子可重载；同键重复批准替换（续期）", async () => {
  await withStore({}, async ({ store, state, dir }) => {
    store.grant({ toolName: "Bash", ruleContent: "git status", origin: "interactive", ttlDays: 2 });
    store.grant({ toolName: "Bash", ruleContent: "git status", origin: "interactive", ttlDays: 5 });
    await store.flush();

    const filePath = join(dir, "ttl-approvals.json");
    const file = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(file.version, 1);
    assert.equal(file.grants.length, 1, "同 toolName+ruleContent+scopeKey 去重替换");
    assert.equal(file.grants[0].expiresAt, new Date(state.now + 5 * DAY_MS).toISOString());

    // 重载：新实例从文件恢复。
    const reloaded = await TtlApprovalStore.create({ filePath, now: () => state.now });
    const ruleset = reloaded.activeAllowRuleset();
    assert.deepEqual(ruleset.allow, [{ toolName: "Bash", ruleContent: "git status" }]);

    // revoke 后落盘裁剪。
    assert.equal(reloaded.revoke({ toolName: "Bash", ruleContent: "git status" }), 1);
    await reloaded.flush();
    const afterRevoke = JSON.parse(readFileSync(filePath, "utf8"));
    assert.deepEqual(afterRevoke.grants, []);
  });
});

test("迁移：version 缺失按 1 宽松解析；未来版本与损坏文件整份作废（fail-closed）", async () => {
  await withStore({}, async () => {
    const dir = mkdtempSync(join(tmpdir(), "acode-ttl-migration-"));
    const warnings = [];
    const now = 1_700_000_000_000;
    const create = async (filePath) =>
      TtlApprovalStore.create({
        filePath,
        now: () => now,
        warn: (message, details) => warnings.push({ message, details }),
      });
    try {
      const filePath = join(dir, "ttl-approvals.json");
      const validGrant = {
        grantId: "g-1",
        toolName: "Bash",
        expiresAt: new Date(now + 10 * DAY_MS).toISOString(),
        grantedAt: new Date(now).toISOString(),
        origin: "interactive",
      };

      // v0 形态（version 缺失）：逐条校验即迁移。
      writeFileSync(filePath, JSON.stringify({ grants: [validGrant, { toolName: "" }] }), "utf8");
      let store = await create(filePath);
      assert.equal(store.listActive().length, 1);
      assert.ok(warnings.some((entry) => /dropped invalid or expired/.test(entry.message)));

      // 未来版本：整份作废 + 告警。
      warnings.length = 0;
      writeFileSync(filePath, JSON.stringify({ version: 2, grants: [validGrant] }), "utf8");
      store = await create(filePath);
      assert.deepEqual(store.listActive(), []);
      assert.ok(warnings.some((entry) => /newer than this build/.test(entry.message)));

      // 损坏 JSON：整份作废 + 告警。
      warnings.length = 0;
      writeFileSync(filePath, "{not json", "utf8");
      store = await create(filePath);
      assert.deepEqual(store.listActive(), []);
      assert.ok(warnings.some((entry) => /corrupt/.test(entry.message)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // 纯解析函数的 fail-closed 口径。
    const future = parseTtlPermissionGrantFile({ version: 99, grants: [] }, 0);
    assert.equal(future.futureVersion, true);
    const corrupt = parseTtlPermissionGrantFile("nonsense", 0);
    assert.equal(corrupt.corrupt, true);
  });
});

test("scopeKey：带作用域授权只对同键上下文生效（缺省上下文 fail-closed）", async () => {
  await withStore({}, async ({ store }) => {
    store.grant({ toolName: "Bash", origin: "interactive", ttlDays: 1, scopeKey: "proj-1" });
    store.grant({ toolName: "WebFetch", origin: "interactive", ttlDays: 1 });

    const globalOnly = store.activeAllowRuleset();
    assert.deepEqual(globalOnly.allow, [{ toolName: "WebFetch" }], "缺省上下文只消费用户级授权");

    const scoped = store.activeAllowRuleset({ scopeKey: "proj-1" });
    const names = scoped.allow.map((rule) => rule.toolName).sort();
    assert.deepEqual(names, ["Bash", "WebFetch"]);

    const otherScope = store.activeAllowRuleset({ scopeKey: "proj-2" });
    assert.deepEqual(otherScope.allow, [{ toolName: "WebFetch" }]);
  });
});

test("applyPermissionUpdates: allow+expiresAt 记授权；无人值守无期限走默认；其余不进存储", async () => {
  await withStore({}, async ({ store, state }) => {
    const expiresAt = new Date(state.now + 3 * DAY_MS).toISOString();
    assert.equal(
      store.applyPermissionUpdates(
        [{ type: "addRules", behavior: "allow", rules: [{ toolName: "Bash" }], expiresAt }],
        { origin: "interactive" },
      ),
      1,
    );
    assert.equal(
      store.applyPermissionUpdates(
        [{ type: "addRules", behavior: "allow", rules: [{ toolName: "Write" }] }],
        { origin: "interactive" },
      ),
      0,
      "交互式无期限 allow 维持既有持久规则路径，不进 TTL 存储",
    );
    assert.equal(
      store.applyPermissionUpdates(
        [{ type: "addRules", behavior: "allow", rules: [{ toolName: "Edit" }] }],
        { origin: "unattended" },
      ),
      1,
      "无人值守的持久批准默认带期限",
    );
    const editGrant = store.listActive().find((grant) => grant.toolName === "Edit");
    assert.equal(editGrant.origin, "unattended");
    assert.equal(editGrant.expiresAt, new Date(state.now + DEFAULT_UNATTENDED_TTL_DAYS * DAY_MS).toISOString());

    assert.equal(
      store.applyPermissionUpdates(
        [{ type: "addRules", behavior: "deny", rules: [{ toolName: "Bash" }], expiresAt }],
        { origin: "interactive" },
      ),
      0,
      "收紧类规则没有到期自动放宽的语义",
    );
    assert.equal(
      store.applyPermissionUpdates(
        [{ type: "addRules", behavior: "allow", rules: [{ toolName: "Read" }], expiresAt: "not-a-date" }],
        { origin: "interactive" },
      ),
      0,
      "期限不可解析：fail-closed 丢弃，不降级成永久",
    );

    // 无人值守带 90 天期限 → 夹紧到 30 天。
    store.applyPermissionUpdates(
      [
        {
          type: "addRules",
          behavior: "allow",
          rules: [{ toolName: "ApplyPatch" }],
          expiresAt: new Date(state.now + 90 * DAY_MS).toISOString(),
        },
      ],
      { origin: "unattended" },
    );
    const patchGrant = store.listActive().find((grant) => grant.toolName === "ApplyPatch");
    assert.equal(patchGrant.expiresAt, new Date(state.now + MAX_UNATTENDED_TTL_DAYS * DAY_MS).toISOString());
  });
});

test("交互式授权期限上限 365 天；默认数据根路径符合 <数据根>/cli/permissions 惯例", () => {
  assert.equal(DEFAULT_MAX_TTL_DAYS, 365);
  const filePath = defaultTtlApprovalFilePath("/data-root");
  assert.equal(filePath.split(/[\\/]/).slice(-3).join("/"), "cli/permissions/ttl-approvals.json");
});
