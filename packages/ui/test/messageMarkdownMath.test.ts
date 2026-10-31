// message.tsx 批次 5 外迁（messageMarkdownMath）的接缝内决策表测试。纯字符串函数、零依赖。
import assert from "node:assert/strict";
import test from "node:test";

import {
  findClosingSingleDollarDelimiter,
  getMarkdownFence,
  isEscapedMarkdownCharacter,
  isLikelyCompactCurrencyRangeText,
  isLikelySingleDollarMath,
  isSingleDollarDelimiter,
  normalizeMessageSingleDollarMath,
  normalizeSingleDollarMathInText,
  normalizeSingleDollarMathOutsideInlineCode,
} from "../src/components/ai-elements/messageMarkdownMath.js";

test("getMarkdownFence：```/~~~ 识别与缩进上限", () => {
  assert.deepEqual(getMarkdownFence("```ts"), { marker: "`", length: 3 });
  assert.deepEqual(getMarkdownFence("   ~~~"), { marker: "~", length: 3 });
  assert.deepEqual(getMarkdownFence("`````"), { marker: "`", length: 5 });
  assert.equal(getMarkdownFence("    ```"), null); // 4 空格缩进是代码块不是围栏
  assert.equal(getMarkdownFence("no fence"), null);
});

test("isEscapedMarkdownCharacter：奇数个前导反斜杠才算转义", () => {
  assert.equal(isEscapedMarkdownCharacter("\\$", 1), true);
  assert.equal(isEscapedMarkdownCharacter("\\\\$", 2), false);
  assert.equal(isEscapedMarkdownCharacter("$", 0), false);
});

test("isSingleDollarDelimiter：相邻 $ 不构成单美元定界", () => {
  assert.equal(isSingleDollarDelimiter("$x", 0), true);
  assert.equal(isSingleDollarDelimiter("$$", 0), false); // 后一个也是 $
  assert.equal(isSingleDollarDelimiter("$$", 1), false); // 前一个也是 $
  assert.equal(isSingleDollarDelimiter("\\$", 1), false); // 转义
});

test("findClosingSingleDollarDelimiter：跳过 $$ 与转义", () => {
  assert.equal(findClosingSingleDollarDelimiter("$a$", 1), 2);
  assert.equal(findClosingSingleDollarDelimiter("$a", 1), -1);
  assert.equal(findClosingSingleDollarDelimiter("$a\\$b$", 1), 5);
});

test("isLikelySingleDollarMath 决策矩阵", () => {
  assert.equal(isLikelySingleDollarMath("x^2"), true); // 数学符号
  assert.equal(isLikelySingleDollarMath("\\alpha"), true); // TeX 命令
  assert.equal(isLikelySingleDollarMath("x"), true); // 简单标识符
  assert.equal(isLikelySingleDollarMath("3.14"), true); // 数字
  assert.equal(isLikelySingleDollarMath("HOME"), false); // 全大写多字母词不在标识符模式内
  assert.equal(isLikelySingleDollarMath("ab1"), true); // 小写开头短标识符
  assert.equal(isLikelySingleDollarMath("5 ..."), false); // 空白后缀（trim 不通过）
  assert.equal(isLikelySingleDollarMath("5 to"), false); // 含空格且非数学符号
  assert.equal(isLikelySingleDollarMath(""), false);
  assert.equal(isLikelySingleDollarMath(" a"), false); // 首尾空白
});

test("isLikelyCompactCurrencyRangeText：$5-$10 形态", () => {
  // text = "$5-$10 后文"，closingIndex 指向第二个 $，content = "5-"
  assert.equal(isLikelyCompactCurrencyRangeText("$5-$10", 3, "5-"), true);
  assert.equal(isLikelyCompactCurrencyRangeText("$5-$ 10", 3, "5-"), false); // 闭包后不是数字
  assert.equal(isLikelyCompactCurrencyRangeText("$x$y", 2, "x"), false); // 前缀不像金额
});

test("normalizeSingleDollarMathInText：公式保留 / 普通文本转义 / 价格区间保留", () => {
  assert.equal(normalizeSingleDollarMathInText("no dollars"), "no dollars");
  assert.equal(normalizeSingleDollarMathInText("公式 $x^2$ 保留"), "公式 $x^2$ 保留");
  // 成对 $ 且内容非公式：只转义开启符；后一个 $ 因再无闭合配对待原文保留。
  assert.equal(normalizeSingleDollarMathInText("价格 $5 ... $10 之间"), "价格 \\$5 ... $10 之间");
  assert.equal(normalizeSingleDollarMathInText("区间 $5-$10 元"), "区间 \\$5-$10 元");
  assert.equal(normalizeSingleDollarMathInText("环境 $HOME 与 $PATH"), "环境 \\$HOME 与 $PATH");
  // 未闭合的 $ 原样保留。
  assert.equal(normalizeSingleDollarMathInText("孤独 $x"), "孤独 $x");
});

test("normalizeSingleDollarMathOutsideInlineCode：行内代码内不转义", () => {
  // 行内代码原样保留；代码外孤立的 $（无闭合配对）也原文保留。
  assert.equal(
    normalizeSingleDollarMathOutsideInlineCode("`$HOME` 与 $PATH 文本"),
    "`$HOME` 与 $PATH 文本",
  );
  // 未闭合的反引号之后全部按文本处理；孤立 $ 不动。
  assert.equal(normalizeSingleDollarMathOutsideInlineCode("`$x"), "`$x");
  // 双反引号包裹单反引号内容。
  assert.equal(
    normalizeSingleDollarMathOutsideInlineCode("`` `$ `` 外 $HOME"),
    "`` `$ `` 外 $HOME",
  );
  // 行内代码外的成对非公式 $ 仍转义开启符。
  assert.equal(
    normalizeSingleDollarMathOutsideInlineCode("`$HOME` 与 $5 ... $10 文本"),
    "`$HOME` 与 \\$5 ... $10 文本",
  );
});

test("normalizeMessageSingleDollarMath：代码围栏内不动，围栏外归一", () => {
  const input = ["公式 $x^2$ 与 $HOME", "```bash", "echo $PATH", "```", "尾部 $PATH"].join("\n");
  // 围栏内 $PATH 不动；围栏外孤立 $HOME/$PATH（无闭合配对）原文保留。
  const expected = ["公式 $x^2$ 与 $HOME", "```bash", "echo $PATH", "```", "尾部 $PATH"].join("\n");
  assert.equal(normalizeMessageSingleDollarMath(input), expected);
  // 围栏外成对非公式 $ 转义开启符。
  const paired = ["```js", "const a = 1;", "```", "价格 $5 ... $10"].join("\n");
  assert.equal(
    normalizeMessageSingleDollarMath(paired),
    ["```js", "const a = 1;", "```", "价格 \\$5 ... $10"].join("\n"),
  );
});

test("normalizeMessageSingleDollarMath：更长围栏闭合短围栏才生效", () => {
  // 外围栏 ```` 包裹内层 ``` 时，内层 ``` 不会提前闭合；结尾孤立 $HOME 原文保留。
  const input = ["````", "```", "$x$", "```", "````", "$HOME"].join("\n");
  assert.equal(normalizeMessageSingleDollarMath(input), input);
  // ~~~ 围栏不能用 ``` 闭合：``` 行与后续内容都仍在围栏内，整体原文不动。
  const mixed = ["~~~", "$x$", "```", "$5 ... $10"].join("\n");
  assert.equal(
    normalizeMessageSingleDollarMath(mixed),
    ["~~~", "$x$", "```", "$5 ... $10"].join("\n"),
  );
});

test("normalizeMessageSingleDollarMath：无 $ 或无换行的快路径", () => {
  assert.equal(normalizeMessageSingleDollarMath("plain text"), "plain text");
  assert.equal(normalizeMessageSingleDollarMath(""), "");
  // 尾随换行保持。
  assert.equal(normalizeMessageSingleDollarMath("$x$\n"), "$x$\n");
});
