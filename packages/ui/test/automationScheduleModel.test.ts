import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUTOMATION_STATUS_DOT_CLASS,
  buildRunsPageItems,
  CUSTOM_REPEAT_INTERVAL_INPUT_MIN,
  CUSTOM_REPEAT_INTERVAL_MAX,
  CUSTOM_REPEAT_INTERVAL_SCHEDULABLE_MIN,
  daysInMonth,
  FREQUENCIES,
  isCronFrequency,
  localDateEndTimestamp,
  normalizeAutomationScheduleRule,
  pad2,
  parseDateInputValue,
  resolveRunStatus,
  RUN_STATUS_DOT_CLASS,
  RUN_STATUS_TEXT_CLASS,
  RUNS_PAGE_SIZE,
  toDateInputValue,
  workspaceLabelFromPath,
} from "@/settings/automation/scheduleModel.js";

/**
 * AutomationEditView 批次 1 helper 外迁的决策表单测。
 * 锁定拆出的纯函数语义：分页 / 日期解析 / 状态决策矩阵。逐字迁移的来源在
 * `settings/AutomationEditView.tsx` 顶部 helper 带，本测试是「行为没有漂移」的接缝保险。
 */
describe("buildRunsPageItems 分页页码序列", () => {
  it("total<=7 时返回 1..total 的连续整数数组", () => {
    assert.deepEqual(buildRunsPageItems(1, 1), [1]);
    assert.deepEqual(buildRunsPageItems(3, 5), [1, 2, 3, 4, 5]);
    assert.deepEqual(buildRunsPageItems(7, 7), [1, 2, 3, 4, 5, 6, 7]);
  });

  it("total>7 且 current 在头部：首 3 页 + ellipsis + 尾 3 页", () => {
    assert.deepEqual(buildRunsPageItems(1, 10), [1, 2, 3, "ellipsis", 8, 9, 10]);
    assert.deepEqual(buildRunsPageItems(2, 10), [1, 2, 3, "ellipsis", 8, 9, 10]);
  });

  it("total>7 且 current 在中段：首 3 页与 current 邻接时**不插入**冗余 ellipsis", () => {
    // 算法只在相邻页码间隔 >1 时插 ellipsis；current=5 时 3 与 4 相邻，故不插。
    assert.deepEqual(buildRunsPageItems(5, 10), [1, 2, 3, 4, 5, 6, "ellipsis", 8, 9, 10]);
    // current=6 时 3 与 5 之间间隔 >1，需要 ellipsis 折叠缺口
    assert.deepEqual(buildRunsPageItems(6, 12), [1, 2, 3, "ellipsis", 5, 6, 7, "ellipsis", 10, 11, 12]);
  });

  it("total>7 且 current 在尾部：首 3 页 + ellipsis + 尾 3 页", () => {
    assert.deepEqual(buildRunsPageItems(9, 10), [1, 2, 3, "ellipsis", 8, 9, 10]);
    assert.deepEqual(buildRunsPageItems(10, 10), [1, 2, 3, "ellipsis", 8, 9, 10]);
  });

  it("越界 current 也不会产生 0 或负数页码", () => {
    const items = buildRunsPageItems(0, 10);
    assert.ok(items.every((item) => item === "ellipsis" || (item >= 1 && item <= 10)));
  });
});

describe("workspaceLabelFromPath", () => {
  it("POSIX 路径取最后一段", () => {
    assert.equal(workspaceLabelFromPath("/home/user/project"), "project");
  });
  it("Windows 反斜杠路径先归一化再取最后一段", () => {
    assert.equal(workspaceLabelFromPath("C:\\Users\\admin\\code"), "code");
  });
  it("末尾带斜杠时忽略空段", () => {
    assert.equal(workspaceLabelFromPath("/a/b/c/"), "c");
  });
  it("纯分隔符路径返回原始 path（filter 后 pop 出 undefined → 兜底）", () => {
    assert.equal(workspaceLabelFromPath("///"), "///");
  });
});

describe("pad2 / daysInMonth", () => {
  it("pad2 单位数补零、双位数原样", () => {
    assert.equal(pad2(0), "00");
    assert.equal(pad2(9), "09");
    assert.equal(pad2(12), "12");
  });
  it("daysInMonth 用闰年 2024：2 月=29、1/3/5/7/8/10/12=31、4/6/9/11=30", () => {
    assert.equal(daysInMonth(2), 29);
    assert.equal(daysInMonth(1), 31);
    assert.equal(daysInMonth(4), 30);
    assert.equal(daysInMonth(12), 31);
  });
});

describe("toDateInputValue / parseDateInputValue / localDateEndTimestamp", () => {
  it("toDateInputValue 接受显式 timestamp，输出 YYYY-MM-DD", () => {
    // 2024-03-05 12:00 UTC，本地时区任意，结果是本地日期
    const value = toDateInputValue(Date.UTC(2024, 2, 5, 12, 0, 0));
    assert.match(value, /^\d{4}-\d{2}-\d{2}$/);
    // 与 parseDateInputValue 来回往返应回到同一日期字符串
    assert.equal(toDateInputValue(parseDateInputValue(value)!.getTime()), value);
  });
  it("toDateInputValue(undefined) 落明天（不抛）", () => {
    const value = toDateInputValue(undefined);
    assert.match(value, /^\d{4}-\d{2}-\d{2}$/);
  });
  it("parseDateInputValue 合法 YYYY-MM-DD → Date，非法 → null", () => {
    const d = parseDateInputValue("2026-02-28");
    assert.ok(d instanceof Date && !Number.isNaN(d.getTime()));
    assert.equal(parseDateInputValue("not-a-date"), null);
    assert.equal(parseDateInputValue("2026/02/28"), null);
  });
  it("localDateEndTimestamp 合法 → 23:59:59.999 的时间戳，非法 → undefined", () => {
    const ts = localDateEndTimestamp("2026-02-28");
    assert.ok(typeof ts === "number" && !Number.isNaN(ts));
    const d = new Date(ts!);
    assert.equal(d.getHours(), 23);
    assert.equal(d.getMinutes(), 59);
    assert.equal(d.getSeconds(), 59);
    assert.equal(d.getMilliseconds(), 999);
    assert.equal(localDateEndTimestamp("bad"), undefined);
  });
});

describe("resolveRunStatus 决策矩阵", () => {
  const make = (
    dispatchStatus: string,
    outcome: string | undefined,
  ): Parameters<typeof resolveRunStatus>[0] =>
    ({ dispatchStatus, outcome }) as never;

  it("dispatchStatus=skipped 优先于 outcome", () => {
    assert.equal(resolveRunStatus(make("skipped", "succeeded")), "skipped");
    assert.equal(resolveRunStatus(make("skipped", undefined)), "skipped");
  });
  it("dispatchStatus=failed_to_dispatch → failed", () => {
    assert.equal(resolveRunStatus(make("failed_to_dispatch", undefined)), "failed");
    assert.equal(resolveRunStatus(make("failed_to_dispatch", "succeeded")), "failed");
  });
  it("outcome 三态：succeeded/failed/stopped", () => {
    assert.equal(resolveRunStatus(make("dispatched", "succeeded")), "succeeded");
    assert.equal(resolveRunStatus(make("dispatched", "failed")), "failed");
    assert.equal(resolveRunStatus(make("dispatched", "stopped")), "stopped");
  });
  it("其它（未结束/未知 outcome）默认 running", () => {
    assert.equal(resolveRunStatus(make("dispatched", undefined)), "running");
    assert.equal(resolveRunStatus(make("dispatched", "running")), "running");
  });
});

describe("状态 class 映射完整性", () => {
  it("RUN_STATUS_DOT_CLASS / RUN_STATUS_TEXT_CLASS 覆盖全部 5 种 RunStatusKind", () => {
    const kinds = ["running", "succeeded", "failed", "stopped", "skipped"] as const;
    for (const kind of kinds) {
      assert.ok(RUN_STATUS_DOT_CLASS[kind], `RUN_STATUS_DOT_CLASS 缺 ${kind}`);
      assert.ok(RUN_STATUS_TEXT_CLASS[kind], `RUN_STATUS_TEXT_CLASS 缺 ${kind}`);
    }
  });
  it("AUTOMATION_STATUS_DOT_CLASS 覆盖全部 4 种 AutomationStatusKind", () => {
    const kinds = ["active", "paused", "failed", "completed"] as const;
    for (const kind of kinds) {
      assert.ok(AUTOMATION_STATUS_DOT_CLASS[kind], `AUTOMATION_STATUS_DOT_CLASS 缺 ${kind}`);
    }
  });
});

describe("normalizeAutomationScheduleRule", () => {
  it("null / undefined 输入 → null", () => {
    assert.equal(normalizeAutomationScheduleRule(null), null);
    assert.equal(normalizeAutomationScheduleRule(undefined), null);
  });
  it("完整 rule 原样归一化（weekdays/monthDays/months/monthlyMode 缺省落到安全默认）", () => {
    const rule = {
      unit: "daily",
      interval: 2,
      hour: 9,
      minute: 30,
      anchorAt: 1700000000000,
    } as never;
    assert.deepEqual(normalizeAutomationScheduleRule(rule), {
      unit: "daily",
      interval: 2,
      hour: 9,
      minute: 30,
      anchorAt: 1700000000000,
      weekdays: [],
      monthDays: [],
      months: [],
      monthlyMode: "date",
    });
  });
  it("已带 weekdays/monthDays/months/monthlyMode 时透传", () => {
    const rule = {
      unit: "weekly",
      interval: 1,
      hour: 8,
      minute: 0,
      anchorAt: 1700000000000,
      weekdays: [1, 3, 5],
      monthDays: [15],
      months: [6],
      monthlyMode: "weekday",
    } as never;
    const normalized = normalizeAutomationScheduleRule(rule)!;
    assert.deepEqual(normalized.weekdays, [1, 3, 5]);
    assert.deepEqual(normalized.monthDays, [15]);
    assert.deepEqual(normalized.months, [6]);
    assert.equal(normalized.monthlyMode, "weekday");
  });
});

describe("常量与类型守卫", () => {
  it("RUNS_PAGE_SIZE = 8（Scheduled 历史表密度规格）", () => {
    assert.equal(RUNS_PAGE_SIZE, 8);
  });
  it("自定义重复区间常量顺序：INPUT_MIN < SCHEDULABLE_MIN < MAX", () => {
    assert.ok(CUSTOM_REPEAT_INTERVAL_INPUT_MIN < CUSTOM_REPEAT_INTERVAL_SCHEDULABLE_MIN);
    assert.ok(CUSTOM_REPEAT_INTERVAL_SCHEDULABLE_MIN <= CUSTOM_REPEAT_INTERVAL_MAX);
  });
  it("FREQUENCIES 覆盖 6 种 CronFrequency", () => {
    assert.deepEqual(FREQUENCIES, ["hourly", "daily", "weekdays", "weekly", "monthly", "custom"]);
  });
  it("isCronFrequency 类型守卫", () => {
    assert.ok(isCronFrequency("daily"));
    assert.ok(isCronFrequency("custom"));
    assert.equal(isCronFrequency("yearly"), false);
    assert.equal(isCronFrequency(""), false);
  });
});
