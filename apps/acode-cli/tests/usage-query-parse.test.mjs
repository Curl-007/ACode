import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * /usage 参数解析全谱单测（specs/usage-statusbar.md「/usage 命令族」节 + 验收场景 4）：
 * 闭集 scope、默认值、非法参数回执码、边界 N=0 / 超大 N。
 */

const { parseUsageQueryArgs } = await import("../packages/core/src/usage-query/index.ts");

function parse(args) {
  return parseUsageQueryArgs(args);
}

test("parse: 空参数与 today/week/current 关键词（大小写不敏感、容忍空白）", () => {
  assert.deepEqual(parse(""), { ok: true, scope: { kind: "range", range: "today", days: 1 } });
  assert.deepEqual(parse("   "), { ok: true, scope: { kind: "range", range: "today", days: 1 } });
  assert.deepEqual(parse("today"), { ok: true, scope: { kind: "range", range: "today", days: 1 } });
  assert.deepEqual(parse(" TODAY "), { ok: true, scope: { kind: "range", range: "today", days: 1 } });
  assert.deepEqual(parse("week"), { ok: true, scope: { kind: "range", range: "week", days: 7 } });
  assert.deepEqual(parse("Week"), { ok: true, scope: { kind: "range", range: "week", days: 7 } });
  assert.deepEqual(parse("current"), { ok: true, scope: { kind: "current" } });
  assert.deepEqual(parse("CURRENT"), { ok: true, scope: { kind: "current" } });
});

test("parse: days:N 合法值与默认边界", () => {
  assert.deepEqual(parse("days:1"), { ok: true, scope: { kind: "range", range: "days", days: 1 } });
  assert.deepEqual(parse("days:3"), { ok: true, scope: { kind: "range", range: "days", days: 3 } });
  assert.deepEqual(parse("Days:30"), { ok: true, scope: { kind: "range", range: "days", days: 30 } });
  assert.deepEqual(parse("days:365"), { ok: true, scope: { kind: "range", range: "days", days: 365 } });
});

test("parse: days:N 边界 N=0 / 超上限 / 超大 N 一律 outOfRange 回执", () => {
  const zero = parse("days:0");
  assert.equal(zero.ok, false);
  assert.deepEqual(zero.error, {
    code: "outOfRange",
    value: "days:0",
    field: "days",
    min: 1,
    max: 365,
  });
  const over = parse("days:366");
  assert.equal(over.ok, false);
  assert.equal(over.error.code, "outOfRange");
  const huge = parse("days:999999999999");
  assert.equal(huge.ok, false);
  assert.equal(huge.error.code, "outOfRange");
  // 超过 12 位数字不再当数值解析（防 Number 精度劣化），走 invalidNumber。
  const tooLong = parse("days:10000000000000");
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.error.code, "invalidNumber");
});

test("parse: days:N 非整数形态给 invalidNumber 回执", () => {
  for (const args of ["days:abc", "days:3.5", "days:+3", "days:-1", "days:１"]) {
    const result = parse(args);
    assert.equal(result.ok, false, args);
    assert.equal(result.error.code, "invalidNumber", args);
    assert.equal(result.error.field, "days", args);
  }
});

test("parse: sessions[:N] 默认 10、合法 N 与边界", () => {
  assert.deepEqual(parse("sessions"), { ok: true, scope: { kind: "sessions", limit: 10 } });
  assert.deepEqual(parse("sessions:1"), { ok: true, scope: { kind: "sessions", limit: 1 } });
  assert.deepEqual(parse("sessions:100"), { ok: true, scope: { kind: "sessions", limit: 100 } });
  const zero = parse("sessions:0");
  assert.equal(zero.ok, false);
  assert.equal(zero.error.code, "outOfRange");
  assert.equal(zero.error.field, "limit");
  const over = parse("sessions:101");
  assert.equal(over.ok, false);
  assert.equal(over.error.code, "outOfRange");
});

test("parse: models[:N] 默认 7 天、N=天数语义与边界", () => {
  assert.deepEqual(parse("models"), { ok: true, scope: { kind: "models", days: 7 } });
  assert.deepEqual(parse("models:14"), { ok: true, scope: { kind: "models", days: 14 } });
  assert.deepEqual(parse("models:90"), { ok: true, scope: { kind: "models", days: 90 } });
  const zero = parse("models:0");
  assert.equal(zero.ok, false);
  assert.equal(zero.error.code, "outOfRange");
  const over = parse("models:91");
  assert.equal(over.ok, false);
  assert.equal(over.error.code, "outOfRange");
});

test("parse: workspace:关键词（保留原始大小写、允许空格、trim）", () => {
  assert.deepEqual(parse("workspace:acode"), {
    ok: true,
    scope: { kind: "workspace", keyword: "acode" },
  });
  assert.deepEqual(parse("Workspace:My Project"), {
    ok: true,
    scope: { kind: "workspace", keyword: "My Project" },
  });
  assert.deepEqual(parse("workspace:  spaced  "), {
    ok: true,
    scope: { kind: "workspace", keyword: "spaced" },
  });
  const empty = parse("workspace:");
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, "emptyKeyword");
  const blank = parse("workspace:   ");
  assert.equal(blank.ok, false);
  assert.equal(blank.error.code, "emptyKeyword");
});

test("parse: session:ID前缀", () => {
  assert.deepEqual(parse("session:ses_ab"), {
    ok: true,
    scope: { kind: "session", prefix: "ses_ab" },
  });
  const empty = parse("session:");
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, "emptyPrefix");
});

test("parse: 多参数与未知 scope", () => {
  const multi = parse("today week");
  assert.equal(multi.ok, false);
  assert.deepEqual(multi.error, { code: "multipleArgs", value: "today week" });
  const multiColon = parse("days:3 extra");
  assert.equal(multiColon.ok, false);
  assert.equal(multiColon.error.code, "multipleArgs");
  const unknown = parse("bogus");
  assert.equal(unknown.ok, false);
  assert.deepEqual(unknown.error, { code: "unknownScope", value: "bogus" });
  // 冒号头不在闭集内 → 整体按 unknownScope 处理。
  const unknownColon = parse("usage:3");
  assert.equal(unknownColon.ok, false);
  assert.equal(unknownColon.error.code, "unknownScope");
  assert.equal(unknownColon.error.value, "usage:3");
});
