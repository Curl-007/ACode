import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultBuilder,
  type CronBuilderState,
} from "@/settings/automation/cronBuilder.js";
import {
  cronBuilderReducer,
  type CronBuilderAction,
} from "@/settings/automation/cronBuilderReducer.js";

/**
 * AutomationEditView 批次 3：cron builder reducer 决策表单测。
 *
 * 锁定两件事：
 *   - 每个 action 的 state 转移语义（含 frequency 切换的 weekdays 强制规则、
 *     CustomRepeatDialog onConfirm 一次性提交、reset 整体替换）；
 *   - reducer 是纯函数（不改原 state 引用，返回新对象）。
 */
describe("cronBuilderReducer · setFrequency", () => {
  it("切到 weekdays：强制 weekdays=[1..5]，其它字段保留", () => {
    const base: CronBuilderState = {
      ...defaultBuilder(),
      frequency: "daily",
      hour: 8,
      minute: 30,
      weekdays: [1],
      customInterval: 7,
    };
    const next = cronBuilderReducer(base, {
      type: "setFrequency",
      frequency: "weekdays",
    });
    assert.equal(next.frequency, "weekdays");
    assert.deepEqual(next.weekdays, [1, 2, 3, 4, 5]);
    assert.equal(next.hour, 8);
    assert.equal(next.minute, 30);
    assert.equal(next.customInterval, 7);
  });

  it("切到非 weekdays 频率：weekdays 字段不动", () => {
    const base: CronBuilderState = {
      ...defaultBuilder(),
      frequency: "daily",
      weekdays: [2, 4],
    };
    const next = cronBuilderReducer(base, {
      type: "setFrequency",
      frequency: "monthly",
    });
    assert.equal(next.frequency, "monthly");
    assert.deepEqual(next.weekdays, [2, 4]);
  });

  it("切到 custom：保留 custom* 字段，不改 weekdays", () => {
    const base: CronBuilderState = {
      ...defaultBuilder(),
      frequency: "daily",
      customInterval: 5,
      customUnit: "weekly",
      customWeekdays: [1, 3],
      weekdays: [2],
    };
    const next = cronBuilderReducer(base, {
      type: "setFrequency",
      frequency: "custom",
    });
    assert.equal(next.frequency, "custom");
    assert.equal(next.customInterval, 5);
    assert.equal(next.customUnit, "weekly");
    assert.deepEqual(next.customWeekdays, [1, 3]);
    assert.deepEqual(next.weekdays, [2]);
  });

  it("reducer 是纯函数：不修改原 state，返回新引用", () => {
    const base = defaultBuilder();
    const before = base.weekdays;
    const next = cronBuilderReducer(base, {
      type: "setFrequency",
      frequency: "weekdays",
    });
    assert.notEqual(next, base);
    assert.equal(base.weekdays, before);
    assert.deepEqual(base.weekdays, [1]);
  });
});

describe("cronBuilderReducer · 单字段更新", () => {
  it("setDayOfMonth：只改 dayOfMonth", () => {
    const base = defaultBuilder();
    const next = cronBuilderReducer(base, { type: "setDayOfMonth", dayOfMonth: 15 });
    assert.equal(next.dayOfMonth, 15);
    assert.equal(next.hour, base.hour);
    assert.equal(next.frequency, base.frequency);
  });

  it("setWeekdays：整体替换 weekdays 数组", () => {
    const base = defaultBuilder();
    const next = cronBuilderReducer(base, {
      type: "setWeekdays",
      weekdays: [0, 3, 6],
    });
    assert.deepEqual(next.weekdays, [0, 3, 6]);
  });

  it("setTimeOfDay：同时更新 hour 和 minute", () => {
    const base = defaultBuilder();
    const next = cronBuilderReducer(base, {
      type: "setTimeOfDay",
      hour: 22,
      minute: 45,
    });
    assert.equal(next.hour, 22);
    assert.equal(next.minute, 45);
  });

  it("setMinute：只改 minute（hourly/custom+hourly 用）", () => {
    const base: CronBuilderState = { ...defaultBuilder(), hour: 10, minute: 0 };
    const next = cronBuilderReducer(base, { type: "setMinute", minute: 30 });
    assert.equal(next.minute, 30);
    assert.equal(next.hour, 10);
  });

  it("setYearlyMonthDay：month 落到 customMonth，day 落到 customMonthDays[0]", () => {
    const base = defaultBuilder();
    const next = cronBuilderReducer(base, {
      type: "setYearlyMonthDay",
      month: 12,
      day: 25,
    });
    assert.equal(next.customMonth, 12);
    assert.deepEqual(next.customMonthDays, [25]);
  });
});

describe("cronBuilderReducer · applyCustomRepeat", () => {
  it("onConfirm 一次性提交：强制 frequency=custom，5 个 custom* 字段更新", () => {
    const base: CronBuilderState = {
      ...defaultBuilder(),
      frequency: "daily",
      customInterval: 1,
      customUnit: "daily",
    };
    const next = cronBuilderReducer(base, {
      type: "applyCustomRepeat",
      interval: 3,
      unit: "weekly",
      weekdays: [1, 3, 5],
      monthDays: [10, 20],
      monthlyMode: "weekday",
    });
    assert.equal(next.frequency, "custom");
    assert.equal(next.customInterval, 3);
    assert.equal(next.customUnit, "weekly");
    assert.deepEqual(next.customWeekdays, [1, 3, 5]);
    assert.deepEqual(next.customMonthDays, [10, 20]);
    assert.equal(next.customMonthlyMode, "weekday");
  });

  it("applyCustomRepeat 不影响 timeOfDay / weekdays / dayOfMonth 等非 custom 字段", () => {
    const base: CronBuilderState = {
      ...defaultBuilder(),
      hour: 8,
      minute: 30,
      weekdays: [2, 4],
      dayOfMonth: 15,
    };
    const next = cronBuilderReducer(base, {
      type: "applyCustomRepeat",
      interval: 2,
      unit: "monthly",
      weekdays: [1],
      monthDays: [1, 15],
      monthlyMode: "date",
    });
    assert.equal(next.hour, 8);
    assert.equal(next.minute, 30);
    assert.deepEqual(next.weekdays, [2, 4]);
    assert.equal(next.dayOfMonth, 15);
  });
});

describe("cronBuilderReducer · reset", () => {
  it("reset 整体替换 builder 状态（编辑对象切换场景）", () => {
    const base = defaultBuilder();
    const incoming: CronBuilderState = {
      frequency: "weekly",
      hour: 7,
      minute: 15,
      weekdays: [1, 5],
      dayOfMonth: 1,
      rawExpr: "15 7 * * 1,5",
      customInterval: 2,
      customUnit: "weekly",
      customWeekdays: [1, 5],
      customMonthDays: [5],
      customMonth: 3,
      customMonthlyMode: "date",
    };
    const next = cronBuilderReducer(base, { type: "reset", next: incoming });
    assert.equal(next, incoming);
    assert.deepEqual(next.weekdays, [1, 5]);
    assert.equal(next.hour, 7);
  });

  it("reset 后旧 state 不被修改", () => {
    const base = defaultBuilder();
    const incoming: CronBuilderState = { ...defaultBuilder(), frequency: "hourly" };
    cronBuilderReducer(base, { type: "reset", next: incoming });
    assert.equal(base.frequency, "daily");
  });
});

describe("cronBuilderReducer · 类型与遍历", () => {
  it("所有 action type 都落在 discriminated union 内（类型断言）", () => {
    const actionTypes: CronBuilderAction["type"][] = [
      "setFrequency",
      "setDayOfMonth",
      "setWeekdays",
      "setTimeOfDay",
      "setMinute",
      "setYearlyMonthDay",
      "applyCustomRepeat",
      "reset",
    ];
    assert.equal(actionTypes.length, 8);
  });

  it("frequency 切换两次的结果与一次性相同（幂等性，无累积副作用）", () => {
    const base = defaultBuilder();
    const step1 = cronBuilderReducer(base, {
      type: "setFrequency",
      frequency: "weekdays",
    });
    const step2 = cronBuilderReducer(step1, {
      type: "setFrequency",
      frequency: "daily",
    });
    const step3 = cronBuilderReducer(step2, {
      type: "setFrequency",
      frequency: "weekdays",
    });
    assert.deepEqual(step3.weekdays, [1, 2, 3, 4, 5]);
    assert.equal(step3.frequency, "weekdays");
  });
});
