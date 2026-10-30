import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultBuilder,
  initialBuilder,
  type CronBuilderState,
} from "@/settings/automation/cronBuilder.js";

/**
 * AutomationEditView 批次 1 helper 外迁的 cron builder 决策表单测。
 * 锁定两个工厂函数：
 *   - defaultBuilder 每次调用都返回**新对象**（引用不等），字段值稳定；
 *   - initialBuilder 的「editing 优先、initialDraft 兜底、scheduleRule 覆盖」三路分支。
 */
describe("defaultBuilder 初值稳定性", () => {
  it("字段值符合 cron builder 规格", () => {
    const b = defaultBuilder();
    assert.equal(b.frequency, "daily");
    assert.equal(b.hour, 9);
    assert.equal(b.minute, 0);
    assert.deepEqual(b.weekdays, [1]);
    assert.equal(b.dayOfMonth, 1);
    assert.equal(b.rawExpr, "0 9 * * *");
    assert.equal(b.customInterval, 1);
    assert.equal(b.customUnit, "daily");
    assert.deepEqual(b.customWeekdays, [1]);
    assert.deepEqual(b.customMonthDays, [1]);
    // customMonth = 当前月份（1-12），允许跨调用方时钟漂移，只锁范围
    assert.ok(b.customMonth >= 1 && b.customMonth <= 12);
    assert.equal(b.customMonthlyMode, "date");
  });

  it("连续两次调用返回不同引用（避免共享可变性）", () => {
    const a = defaultBuilder();
    const b = defaultBuilder();
    assert.notEqual(a, b);
    a.weekdays.push(5);
    assert.deepEqual(b.weekdays, [1]);
  });
});

describe("initialBuilder 三路分支", () => {
  it("editing=null 且无 initialDraft → 等同 defaultBuilder 字段", () => {
    const b = initialBuilder(null);
    const d = defaultBuilder();
    // 不比对 customMonth（时钟漂移），只比对稳定字段
    assert.equal(b.frequency, d.frequency);
    assert.equal(b.hour, d.hour);
    assert.equal(b.minute, d.minute);
    assert.equal(b.rawExpr, d.rawExpr);
    assert.deepEqual(b.weekdays, d.weekdays);
    assert.deepEqual(b.customWeekdays, d.customWeekdays);
  });

  it("editing=null 但有 initialDraft → 走 parseCronToBuilder(initialDraft.cronExpr)", () => {
    const b = initialBuilder(null, { title: "t", cronExpr: "30 8 * * *", prompt: "p" });
    // 8:30 daily cron → frequency=daily / hour=8 / minute=30
    assert.equal(b.frequency, "daily");
    assert.equal(b.hour, 8);
    assert.equal(b.minute, 30);
  });

  it("editing 无 scheduleRule → 直接从 cronExpr 反推", () => {
    const editing = {
      cronExpr: "15 10 * * *",
      scheduleRule: null,
    } as never;
    const b = initialBuilder(editing);
    assert.equal(b.frequency, "daily");
    assert.equal(b.hour, 10);
    assert.equal(b.minute, 15);
  });

  it("editing 有 scheduleRule → frequency=custom 且各 custom* 字段被 scheduleRule 覆盖", () => {
    const editing = {
      cronExpr: "0 9 * * *",
      scheduleRule: {
        unit: "weekly",
        interval: 3,
        hour: 7,
        minute: 45,
        anchorAt: Date.UTC(2026, 5, 15, 12, 0, 0),
        weekdays: [1, 3, 5],
        monthDays: [10, 20],
        months: [6],
        monthlyMode: "weekday",
      },
    } as never;
    const b: CronBuilderState = initialBuilder(editing);
    assert.equal(b.frequency, "custom");
    assert.equal(b.hour, 7);
    assert.equal(b.minute, 45);
    assert.equal(b.customInterval, 3);
    assert.equal(b.customUnit, "weekly");
    assert.deepEqual(b.customWeekdays, [1, 3, 5]);
    assert.deepEqual(b.customMonthDays, [10, 20]);
    assert.equal(b.customMonth, 6);
    assert.equal(b.customMonthlyMode, "weekday");
  });

  it("scheduleRule 缺 weekdays/monthDays/months 时落到安全默认；months 缺时按 anchorAt 推月", () => {
    // anchorAt 2026-07-15（本地月份应为 7）
    const editing = {
      cronExpr: "0 9 * * *",
      scheduleRule: {
        unit: "daily",
        interval: 1,
        hour: 9,
        minute: 0,
        anchorAt: new Date(2026, 6, 15, 12, 0, 0).getTime(),
      },
    } as never;
    const b = initialBuilder(editing);
    assert.equal(b.frequency, "custom");
    assert.deepEqual(b.customWeekdays, [1]);
    assert.deepEqual(b.customMonthDays, [1]);
    assert.equal(b.customMonth, 7);
    assert.equal(b.customMonthlyMode, "date");
  });
});
