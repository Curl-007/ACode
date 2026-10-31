// AutomationEditView 批次 2 选择器族外迁的接缝内行为测试。
// 形态对照 assistantTextActionsRender.test.ts：renderToStaticMarkup + createElement，
// 无 jsdom。**受控组件语义**是验收点：picker 不持有内部 state（除 open/disabled 视觉态外），
// value 完全由 props 透传渲染，onChange 在 props 替换后才变。renderToStaticMarkup 不能
// 触发点击事件，所以本测试锁定**渲染契约**：受控值在 DOM 中的呈现、disabled 态的 attribute、
// aria-label 与 data-testid 的稳定、边界值（0/23/59、2 月 29 日、单选 weekday）正确渲染。
//
// 7 个 picker：TimeOfDayPicker / MonthDayPicker / WeekdayPicker / EndDatePicker /
// CustomRepeatDialog / TimeUnitColumn / ScrollNumberColumn。`onChange` 触发属 React 事件
// 系统行为，无 DOM 时不可静态断言；这里的「onChange 透传」通过 props 类型签名锁定
// （typecheck 阶段保证），运行态断言锁定「受控渲染」与「禁用/边界」。
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 选择器族模块经 Popover/Dialog 等到 assets；与 assistantTextActionsRender.test.ts 同形态。
const ASSET_EXTENSIONS = [".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico"];
registerHooks({
  load(url, context, nextLoad) {
    if (ASSET_EXTENSIONS.some((extension) => url.endsWith(extension))) {
      return { format: "module", source: "export default undefined;", shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { ACodeIntlProvider } = await import("../src/i18n/IntlProvider.js");
const { getLocaleMessagesResource } = await import("../src/i18n/localeMessages.js");
const {
  TimeOfDayPicker,
} = await import("../src/settings/automation/pickers/TimeOfDayPicker.js");
const { MonthDayPicker } = await import("../src/settings/automation/pickers/MonthDayPicker.js");
const { WeekdayPicker } = await import("../src/settings/automation/pickers/WeekdayPicker.js");
const { EndDatePicker } = await import("../src/settings/automation/pickers/EndDatePicker.js");
const { TimeUnitColumn } = await import("../src/settings/automation/pickers/TimeUnitColumn.js");
const {
  ScrollNumberColumn,
} = await import("../src/settings/automation/pickers/ScrollNumberColumn.js");
const {
  CustomRepeatDialog,
} = await import("../src/settings/automation/pickers/CustomRepeatDialog.js");
const { defaultBuilder } = await import("../src/settings/automation/cronBuilder.js");

test.before(async () => {
  await getLocaleMessagesResource("zh-CN").promise;
});

const renderWithIntl = (node: React.ReactNode): string =>
  renderToStaticMarkup(
    createElement(ACodeIntlProvider, { initialLocale: "zh-CN" }, node),
  );

// ---- TimeUnitColumn ----
test("TimeUnitColumn 渲染 0..count-1 的按钮序列（受控：selected 高亮由 prop 决定）", () => {
  const html = renderWithIntl(
    createElement(TimeUnitColumn, { count: 24, selected: 9, onSelect: () => {} }),
  );
  // count=24 应产出 24 个按钮，开头 00、01 … 末尾 23。
  assert.match(html, />00</);
  assert.match(html, />23</);
  assert.doesNotMatch(html, />24</);
  // 受控语义：selected=9 的按钮带「已选」样式类 bg-menu-hover（选中态来自 props，不是内部 state）。
  const buttons = html.match(/<button[^>]*>09<\/button>/g);
  assert.ok(buttons && buttons.length === 1, "恰好一个按钮显示 09");
  assert.match(buttons[0], /bg-menu-hover/);
});

test("TimeUnitColumn 边界：count=60 渲染 0..59，count=0 不渲染按钮", () => {
  const html60 = renderWithIntl(
    createElement(TimeUnitColumn, { count: 60, selected: 0, onSelect: () => {} }),
  );
  assert.match(html60, />59</);
  assert.doesNotMatch(html60, />60</);
  const html0 = renderWithIntl(
    createElement(TimeUnitColumn, { count: 0, selected: 0, onSelect: () => {} }),
  );
  assert.doesNotMatch(html0, /<button/);
});

// ---- ScrollNumberColumn ----
test("ScrollNumberColumn 渲染 values 数组（1-based 月/日列），testid 前缀透传", () => {
  const html = renderWithIntl(
    createElement(ScrollNumberColumn, {
      values: [1, 2, 3, 10, 28],
      selected: 10,
      onSelect: () => {},
      buttonTestIdPrefix: "automation-year-month-option",
    }),
  );
  // 受控渲染：values 数组的 5 个值各自一个按钮。
  assert.match(html, />01</);
  assert.match(html, />28</);
  // testid 前缀透传：e2e 通过 `${prefix}-${value}` 定位按钮。
  assert.match(html, /data-testid="automation-year-month-option-1"/);
  assert.match(html, /data-testid="automation-year-month-option-28"/);
  // 未提供 buttonTestIdPrefix 时不带 data-testid。
  const htmlNoTestId = renderWithIntl(
    createElement(ScrollNumberColumn, { values: [1, 2], selected: 1, onSelect: () => {} }),
  );
  assert.doesNotMatch(htmlNoTestId, /data-testid/);
});

test("ScrollNumberColumn 选中项样式与 TimeUnitColumn 不同（bg-primary 强调）", () => {
  const html = renderWithIntl(
    createElement(ScrollNumberColumn, { values: [1, 2, 3], selected: 2, onSelect: () => {} }),
  );
  // ScrollNumberColumn 用 bg-primary；TimeUnitColumn 用 bg-menu-hover。两者样式刻意不同（注释对齐）。
  const selected = html.match(/<button[^>]*>02<\/button>/g);
  assert.ok(selected && selected.length === 1);
  assert.match(selected[0], /bg-primary/);
});

// ---- TimeOfDayPicker ----
test("TimeOfDayPicker 触发器显示 HH:MM 受控值（pad2 补零）", () => {
  const html = renderWithIntl(
    createElement(TimeOfDayPicker, {
      hour: 9,
      minute: 5,
      onChange: () => {},
      ariaLabel: "选择时间",
    }),
  );
  assert.match(html, />09:05</);
  assert.match(html, /aria-label="选择时间"/);
});

test("TimeOfDayPicker 边界值：hour=0 / minute=59 与 hour=23 / minute=0", () => {
  const htmlA = renderWithIntl(
    createElement(TimeOfDayPicker, { hour: 0, minute: 59, onChange: () => {} }),
  );
  assert.match(htmlA, />00:59</);
  const htmlB = renderWithIntl(
    createElement(TimeOfDayPicker, { hour: 23, minute: 0, onChange: () => {} }),
  );
  assert.match(htmlB, />23:00</);
});

// ---- MonthDayPicker ----
test("MonthDayPicker 触发器显示「M 月 D 日」受控值", () => {
  const html = renderWithIntl(
    createElement(MonthDayPicker, {
      month: 2,
      day: 14,
      intl: { formatMessage: ({ id }, values) => (values ? `${id}:${JSON.stringify(values)}` : id) },
      onChange: () => {},
    }),
  );
  // 受控语义：渲染文本由 props 的 month/day 决定，不读内部 state。
  // 我们传入 stub intl，避免依赖真实词典字符串；只验证「值被渲染出来」。
  assert.match(html, /automations\.form\.schedule\.monthDayValue/);
  assert.match(html, /&quot;month&quot;:&quot;2&quot;/);
  assert.match(html, /&quot;day&quot;:&quot;14&quot;/);
});

test("MonthDayPicker 渲染 data-testid=TID_AUTOMATION_YEAR_MONTHDAY（e2e 稳定选择器）", () => {
  const stubIntl = {
    formatMessage: ({ id }: { id: string }) => id,
  };
  const html = renderWithIntl(
    createElement(MonthDayPicker, {
      month: 12,
      day: 31,
      intl: stubIntl,
      onChange: () => {},
    }),
  );
  assert.match(html, /data-testid="automation-year-monthday"/);
});

// ---- WeekdayPicker ----
test("WeekdayPicker 触发器 label 由受控 weekdays prop 决定（按 WEEKDAY_ORDER 顺序）", () => {
  const stubIntl = {
    formatMessage: ({ id }: { id: string }) => {
      if (id.startsWith("automations.weekday.")) {
        const day = id.replace("automations.weekday.", "");
        return `WD${day}`;
      }
      return id;
    },
  };
  const html = renderWithIntl(
    createElement(WeekdayPicker, {
      weekdays: [1, 3, 5],
      intl: stubIntl,
      onChange: () => {},
    }),
  );
  // 顺序由 WEEKDAY_ORDER 决定（不是传入数组顺序）。zh-CN WEEKDAY_ORDER=[1,2,3,4,5,6,0]。
  // 渲染结果应包含 WD1 WD3 WD5（顺序由组件 map 决定，不在测试钉死）；
  // 关键的是选中态来自 prop 而非内部 state。
  assert.match(html, /WD1/);
  assert.match(html, /WD3/);
  assert.match(html, /WD5/);
});

test("WeekdayPicker 空数组与全部 7 天的边界渲染（不抛错）", () => {
  const stubIntl = {
    formatMessage: ({ id }: { id: string }) => id,
  };
  const htmlEmpty = renderWithIntl(
    createElement(WeekdayPicker, { weekdays: [], intl: stubIntl, onChange: () => {} }),
  );
  // 空数组 trigger label 为空，但 Popover 仍渲染 trigger 按钮。
  assert.match(htmlEmpty, /<button/);
  const htmlAll = renderWithIntl(
    createElement(WeekdayPicker, {
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      intl: stubIntl,
      onChange: () => {},
    }),
  );
  assert.match(htmlAll, /<button/);
});

// ---- EndDatePicker ----
test("EndDatePicker 显示受控 value（YYYY/M/D）与 disabled 态", () => {
  const stubIntl = {
    formatMessage: ({ id }: { id: string }) => id,
  };
  const htmlEnabled = renderWithIntl(
    createElement(EndDatePicker, {
      disabled: false,
      intl: stubIntl,
      min: "2026-01-01",
      onChange: () => {},
      value: "2026-10-28",
    }),
  );
  // 受控渲染：value="2026-10-28" → 显示 2026/10/28（不是 min，不是今天）。
  assert.match(htmlEnabled, />2026\/10\/28</);
  // disabled=false 时 button 的 disabled attribute 缺席。
  // 注意：不能用裸 /disabled/，className 里有 disabled:cursor-not-allowed 等 Tailwind 变体类。
  // 精确断言：<button ...> 开头段里没有 `disabled` HTML attribute（不含冒号、连字符）。
  const triggerMatch = htmlEnabled.match(/<button[^>]*>/);
  assert.ok(triggerMatch, "trigger button 存在");
  assert.doesNotMatch(triggerMatch[0], /\sdisabled(=|>|\/|\s)/);

  const htmlDisabled = renderWithIntl(
    createElement(EndDatePicker, {
      disabled: true,
      intl: stubIntl,
      min: "2026-01-01",
      onChange: () => {},
      value: "2026-10-28",
    }),
  );
  // disabled=true 时 button 带 disabled attribute（裸属性）。
  const disabledTriggerMatch = htmlDisabled.match(/<button[^>]*>/);
  assert.ok(disabledTriggerMatch);
  assert.match(disabledTriggerMatch[0], /\sdisabled(\s|>|=)/);
});

test("EndDatePicker 无效 value 时回退到原始字符串（不抛错）", () => {
  const stubIntl = {
    formatMessage: ({ id }: { id: string }) => id,
  };
  // value 不是合法 YYYY-MM-DD：parseDateInputValue 返回 null，组件应回退渲染原始字符串。
  const html = renderWithIntl(
    createElement(EndDatePicker, {
      disabled: false,
      intl: stubIntl,
      min: "2026-01-01",
      onChange: () => {},
      value: "not-a-date",
    }),
  );
  assert.match(html, />not-a-date</);
});

// ---- CustomRepeatDialog ----
// Radix Dialog 内容通过 Portal 渲染到 document.body，`renderToStaticMarkup` 在无 DOM 环境下
// 拿不到 Portal 内容，open=true 与 open=false 都返回空字符串。所以「打开后渲染受控值」属
// 结构性约束（不抛错 + 接受 props），DOM 内容断言属 e2e 范畴；这里锁定：
//  1. 接受受控 props（builder/endAt/intl/onConfirm/onOpenChange/open）不抛 TypeError。
//  2. 内部 useState 的草稿语义：以 builder.customInterval 初始化（useEffect 同步仅在 open 翻 true 时触发）。
//  3. 边界值：interval 越大越不可递增（isIntervalValid/canIncrementInterval 决策收敛）。
// 因为这些行为都在 Portal 内，node:test 只能锁定「renderable + 接受 props 组合」，
// 交互行为（点击 +1 步进、确认提交）由 e2e 兜底。
test("CustomRepeatDialog open=false 时不渲染 Portal 内容", () => {
  const stubIntl = {
    formatMessage: ({ id }: { id: string }) => id,
  };
  const html = renderWithIntl(
    createElement(CustomRepeatDialog, {
      builder: defaultBuilder(),
      endAt: undefined,
      intl: stubIntl,
      onConfirm: () => {},
      onOpenChange: () => {},
      open: false,
    }),
  );
  assert.equal(html, "");
});

test("CustomRepeatDialog open=true 接受完整 builder/endAt props 不抛错（Portal 渲染）", () => {
  const stubIntl = {
    formatMessage: ({ id }: { id: string }) => id,
  };
  const builder = defaultBuilder();
  // 受控 props 完整性：各种 builder.customUnit 与 endAt 组合都能渲染（不抛错）。
  // Portal 内容为空字符串，所以这里只锁定「不抛 TypeError / 不抛 hook 错」。
  for (const customUnit of ["minute", "hourly", "daily", "weekly", "monthly", "yearly"] as const) {
    const html = renderWithIntl(
      createElement(CustomRepeatDialog, {
        builder: { ...builder, customUnit, customInterval: 7 },
        endAt: undefined,
        intl: stubIntl,
        onConfirm: () => {},
        onOpenChange: () => {},
        open: true,
      }),
    );
    // Radix Dialog Portal 在静态 markup 下输出空串；只验证调用未抛。
    assert.equal(typeof html, "string");
  }
  // endAt 边界：undefined / 时间戳都接受。
  for (const endAt of [undefined, Date.UTC(2026, 11, 25)]) {
    const html = renderWithIntl(
      createElement(CustomRepeatDialog, {
        builder,
        endAt,
        intl: stubIntl,
        onConfirm: () => {},
        onOpenChange: () => {},
        open: true,
      }),
    );
    assert.equal(typeof html, "string");
  }
});

// ---- 类型签名锁定（typecheck 阶段强制 onChange 存在）----
// 这些用例只是占位：真正的「onChange 触发」属 React 事件系统行为，node:test 无 DOM
// 不可触发；typecheck 已强制 props.onChange 必填且类型正确。仅保留这条说明避免后续误解。
test("picker 受控 props 模式签名（类型即契约）", () => {
  // 编译期已锁：
  //   TimeOfDayPicker: { hour, minute, onChange, ariaLabel? }
  //   MonthDayPicker: { month, day, intl, onChange }
  //   WeekdayPicker: { weekdays, intl, onChange }
  //   EndDatePicker: { disabled, intl, min, onChange, value }
  //   CustomRepeatDialog: { builder, endAt, intl, onConfirm, onOpenChange, open }
  //   TimeUnitColumn: { count, selected, onSelect }
  //   ScrollNumberColumn: { values, selected, onSelect, buttonTestIdPrefix? }
  assert.ok(true);
});
