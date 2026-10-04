import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

/**
 * 安全加固 P0-3 的不变量守护测试：bot 绑定码防爆破 + 远程入口权限模式天花板。
 *
 * 仿照 packages/server/tests/server-auth.test.mjs / packages/desktop/tests/no-telemetry.test.mjs 的写法：
 * 纯共享原语（无 import 的叶子模块）直接 import 跑真实行为；botsService.ts 依赖 @acode/rpc 与
 * 大量 .js 规格（type-stripping 下无法解析），故对其接线点用「源码文本不变量」守护——确保
 * 派发咽喉、handleBind、/mode 分支确实挂上了共享原语，且没有残留 randomBytes(3) 旧绑定码。
 *
 * 仅用内存 fixture / 注入时钟：绝不读写真实 ~/.acode 或任何真实凭据，绝不发起网络请求。
 */

// 真实共享原语（dependency-light 叶子，可直接 import）。
const guard = await import("../node_modules/@acode/shared/src/bot-remote-guard.ts");
const messages = await import("../src/bots/messages.ts");

// ── (a) 绑定码尝试守护：N 次错误后锁定 + 指数退避 + 单次成功清零 ───────────────

test("bind attempt guard locks after N consecutive failures (a)", () => {
  let clock = 1_000_000;
  const g = guard.createBotBindAttemptGuard({
    maxAttempts: 5,
    baseLockMs: 30_000,
    maxLockMs: 15 * 60_000,
    now: () => clock,
  });
  // 前 4 次错误不锁定。
  for (let i = 0; i < 4; i += 1) {
    const status = g.recordFailure("bot-1");
    assert.equal(status.locked, false, `failure #${i + 1} should not lock yet`);
    assert.equal(g.isLocked("bot-1").locked, false);
  }
  // 第 5 次错误触发首次锁定（baseLockMs）。
  const locked = g.recordFailure("bot-1");
  assert.equal(locked.locked, true);
  assert.equal(locked.retryAfterMs, 30_000);
  assert.equal(g.isLocked("bot-1").locked, true);
});

test("bind attempt guard applies exponential backoff and caps it (a)", () => {
  let clock = 2_000_000;
  const g = guard.createBotBindAttemptGuard({
    maxAttempts: 2,
    baseLockMs: 1_000,
    maxLockMs: 8_000,
    now: () => clock,
  });
  // 第 2 次失败 → 锁 1s（exponent 0）。
  g.recordFailure("bot-2");
  let s = g.recordFailure("bot-2");
  assert.equal(s.retryAfterMs, 1_000);
  // 推进过锁定期；再失败 → 退避翻倍（2s, 4s, 8s），到上限封顶不再增长。
  clock += 1_001;
  s = g.recordFailure("bot-2");
  assert.equal(s.retryAfterMs, 2_000);
  clock += 2_001;
  s = g.recordFailure("bot-2");
  assert.equal(s.retryAfterMs, 4_000);
  clock += 4_001;
  s = g.recordFailure("bot-2");
  assert.equal(s.retryAfterMs, 8_000);
  clock += 8_001;
  s = g.recordFailure("bot-2");
  assert.equal(s.retryAfterMs, 8_000, "backoff must cap at maxLockMs");
});

test("bind attempt guard isolates bots and clears on success (a)", () => {
  let clock = 3_000_000;
  const g = guard.createBotBindAttemptGuard({
    maxAttempts: 2,
    baseLockMs: 5_000,
    now: () => clock,
  });
  // 一个 bot 被锁不殃及其他。
  g.recordFailure("bot-3");
  assert.equal(g.recordFailure("bot-3").locked, true);
  assert.equal(g.isLocked("bot-4").locked, false);
  // 成功清零：随后单独再犯从首次退避重新开始。
  g.recordSuccess("bot-3");
  assert.equal(g.isLocked("bot-3").locked, false);
  g.recordFailure("bot-3");
  assert.equal(g.recordFailure("bot-3").locked, true);
  // 锁定窗口内的重试不延长锁定（直接回显剩余等待）。
  clock += 1_000;
  assert.equal(g.recordFailure("bot-3").retryAfterMs, 4_000);
});

// ── (b) 远程入口权限模式天花板：yolo/bypass/auto 不可达 ─────────────────────────

test("remote-entry ceiling forbids yolo and bypassPermissions (b)", () => {
  assert.equal(guard.isBotRemoteForbiddenPermissionMode("yolo"), true);
  assert.equal(guard.isBotRemoteForbiddenPermissionMode("bypassPermissions"), true);
  assert.equal(guard.isBotRemoteForbiddenPermissionMode("build"), false);
  assert.equal(guard.isBotRemoteForbiddenPermissionMode("plan"), false);
  assert.equal(guard.isBotRemoteForbiddenPermissionMode("edit"), false);

  // native 支持集 build/edit/plan/yolo 过滤后只剩 build/edit/plan。
  const selectable = guard.filterBotSelectablePermissionModes(["build", "edit", "plan", "yolo"]);
  assert.deepEqual(selectable, ["build", "edit", "plan"]);
  assert.ok(!selectable.includes("yolo"));
});

test("auto is bot-forbidden but NOT bypass-identity (classifier spec R5 constant split)", () => {
  // auto 分类器落地后，bot 天花板含 auto（远程消息→LLM 放行→主机执行不可接受）；
  // 但 auto 不是 bypass 身份档——桌面 execution-state 的 modePolicyForbidden 判定
  // 只认 bypass 身份集，managed policy 下切 auto 不得被误伤。
  assert.equal(guard.isBotRemoteForbiddenPermissionMode("auto"), true);
  assert.equal(guard.isBypassPermissionMode("auto"), false);
  assert.equal(guard.isBypassPermissionMode("yolo"), true);
  assert.deepEqual(
    guard.filterBotSelectablePermissionModes(["build", "edit", "plan", "yolo", "auto"]),
    ["build", "edit", "plan"],
  );
  // 派发咽喉夹取：请求 auto → 回落缺省 build。
  assert.equal(
    guard.clampBotPermissionMode("auto", ["build", "edit", "plan", "yolo", "auto"], "build"),
    "build",
  );
});

test("mode.set draft/active branches reject yolo with the forbidden message (b)", async () => {
  const source = await read("packages/services/src/bots/botsService.ts");
  // 显式全权限请求被识别并回专属提示（而非「模式未找到」）。
  assert.match(source, /isForbiddenModeRequest\(/);
  assert.match(source, /msg\(auth\.locale, "modeRemoteForbidden"\)/);
  // 草稿态可选集与活跃任务态菜单都剔除全权限档。
  assert.match(source, /\.filter\(\(mode\) => !isBotRemoteForbiddenPermissionMode\(mode\.id\)\)/);
  assert.match(
    source,
    /\.filter\(\(candidate\) => !isBotRemoteForbiddenPermissionMode\(candidate\.id\)\)/,
  );

  // 提示文案含「远程入口不支持完全访问」语义（zh + en 一致）。
  assert.match(messages.formatBotMessage("zh-CN", "modeRemoteForbidden"), /远程入口不支持完全访问/);
  assert.match(
    messages.formatBotMessage("en-US", "modeRemoteForbidden"),
    /remote entry does not support full access/i,
  );
});

// ── (c) bot createTask 首条消息默认进入 plan/build 审批模式，不静默 yolo ─────────

test("clampBotPermissionMode never yields a forbidden mode and keeps build/plan (c)", () => {
  const native = ["build", "edit", "plan", "yolo"];
  // build/plan 原样保留（受审批的模式）。
  assert.equal(guard.clampBotPermissionMode("build", native, "build"), "build");
  assert.equal(guard.clampBotPermissionMode("plan", native, "build"), "plan");
  // yolo 被夹到 fallback(build)，绝不放行。
  assert.equal(guard.clampBotPermissionMode("yolo", native, "build"), "build");
  assert.notEqual(guard.clampBotPermissionMode("yolo", native, "build"), "yolo");
  // 不被支持的值也夹到 fallback。
  assert.equal(guard.clampBotPermissionMode("bogus", native, "build"), "build");
});

test("dispatch chokepoint clamps the effective draft mode to the ceiling (c)", async () => {
  const source = await read("packages/services/src/bots/botsService.ts");
  // resolveEffectiveDraftMode 经 clampBotPermissionMode 夹取，且被派发咽喉 applyDraftConfigOptions 调用。
  assert.match(source, /clampBotPermissionMode\(/);
  const effective = source.slice(
    source.indexOf("function resolveEffectiveDraftMode("),
    source.indexOf("function getActorContextKey("),
  );
  assert.match(effective, /clampBotPermissionMode\(/);
  assert.match(effective, /getAgentEnginePermissionModes\(draftOptions\.provider\)/);
  assert.match(effective, /BOT_DEFAULT_DRAFT_MODE/);
});

test("bot default draft mode is build (approval gate), not yolo (c)", async () => {
  const botsShared = await read("packages/shared/src/bots.ts");
  assert.match(botsShared, /BOT_DEFAULT_DRAFT_MODE\s*=\s*"build"/);
  assert.doesNotMatch(botsShared, /BOT_DEFAULT_DRAFT_MODE\s*=\s*"yolo"/);
});

// ── 活跃任务路径的天花板（对抗评审核实的旁路）────────────────────────────────
//
// 旧实现只在 createTask 派发咽喉夹取模式；活跃任务路径直接 resumeTask +
// sendPromptInBackground，因此 /task-attach 到一个已存在的 yolo 任务
// （off-peak/automation 任务默认即 yolo）即可绕过天花板，远程聊天用户在该任务里
// 发消息就是无逐动作确认的任意命令执行。本测试钉住「活跃任务路径也受天花板约束」。

test("active-task dispatch path enforces the ceiling before resumeTask (bypass fix)", async () => {
  const source = await read("packages/services/src/bots/botsService.ts");
  const resumeIdx = source.indexOf("await acodeTaskService.resumeTask({");
  assert.ok(resumeIdx > 0, "active-task resume path not found");
  // 天花板检查必须出现在 resumeTask **之前**——放在之后就已经把 prompt 派出去了。
  const guardIdx = source.indexOf("isBotRemoteForbiddenPermissionMode(activeTaskMode)");
  assert.ok(guardIdx > 0, "active-task mode ceiling guard missing");
  assert.ok(
    guardIdx < resumeIdx,
    "active-task ceiling guard must run BEFORE resumeTask, otherwise the prompt is already dispatched",
  );
  const guardRegion = source.slice(guardIdx - 900, guardIdx + 400);
  // 模式来源必须与 /mode 展示同源（config currentValue ?? task.mode），不能只看 task.mode。
  assert.match(guardRegion, /readCurrentActiveTaskMode\(/);
  // 命中禁止档时拒绝派发并回专属提示，而非静默改写 Session 模式。
  assert.match(guardRegion, /taskModeRemoteForbidden/);
  // 拿不到任务元数据时 fail closed。
  assert.match(guardRegion, /noActiveTask/);
});

test("taskModeRemoteForbidden message exists in both locales", async () => {
  const source = await read("packages/services/src/bots/messages.ts");
  const occurrences = source.match(/taskModeRemoteForbidden:/g) ?? [];
  assert.equal(
    occurrences.length,
    2,
    "taskModeRemoteForbidden must be defined in both zh-CN and en-US",
  );
});

// ── 绑定码熵：randomBytes(3) → ≥ randomBytes(8)；单次使用 + 短 TTL 保留 ──────────

test("bind code widened to >= randomBytes(8) and handleBind is rate-limited", async () => {
  const source = await read("packages/services/src/bots/botsService.ts");
  // 旧的低熵绑定码调用不得残留（仅允许注释里提及 randomBytes(3) 作为对比说明）。
  assert.doesNotMatch(source, /randomBytes\(3\)\.toString/);
  assert.doesNotMatch(source, /return randomBytes\(3\)/);
  assert.match(source, /return randomBytes\(8\)\.toString\("hex"\)\.toUpperCase\(\)/);
  // handleBind 在锁定窗口内直接拒绝，并对错误尝试计数。
  const handleBind = source.slice(
    source.indexOf("async function handleBind("),
    source.indexOf("async function handleStatus("),
  );
  assert.match(handleBind, /bindAttemptGuard\.isLocked\(/);
  assert.match(handleBind, /bindAttemptGuard\.recordFailure\(/);
  assert.match(handleBind, /bindAttemptGuard\.recordSuccess\(/);
  assert.match(handleBind, /msg\(locale, "bindLocked"/);
  // 单次使用 + 短 TTL 仍保留。
  assert.match(handleBind, /bindCodes\.delete\(record\.code\)/);
  assert.match(handleBind, /record\.expiresAt <= Date\.now\(\)/);
});
