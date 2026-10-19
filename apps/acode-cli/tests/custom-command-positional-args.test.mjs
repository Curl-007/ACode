// slash 命令位置参数与单遍模板渲染守护（specs/slash-positional-args.md）。
// 机制参照 oh-my-pi（MIT）packages/coding-agent/src/utils/command-args.ts 的
// substituteArgs：$N 位置参数、$@[start:length] 切片、$@/$ARGUMENTS 聚合、单遍渲染。
import assert from "node:assert/strict";
import { test } from "node:test";

const { expandCliCustomCommandPrompt } = await import(
  "../packages/cli/src/custom-command-expand.ts"
);

function command(content) {
  return {
    content,
    metadata: { name: "demo", scope: "project", source: "agents" },
  };
}

function expand(content, args) {
  return expandCliCustomCommandPrompt({ args, command: command(content) });
}

/** prompt 骨架（无 skills 时）：头两行 + 空行 + body.trim()。 */
function expectedPrompt(body) {
  return `Run custom command /demo.\nCommand source: project/agents.\n\n${body.trim()}`;
}

test("$N 位置参数：按位替换、多位数、缺位与 $0 渲染为空串", () => {
  const args = "alpha beta gamma delta epsilon zeta eta theta iota";
  const result = expand("[$1][$2][$9][$10][$0]", args);
  assert.equal(result.prompt, expectedPrompt("[alpha][beta][iota][][]"));
  assert.equal(result.argumentCount, 9);
  assert.equal(result.usedArgumentsPlaceholder, true);
  // $3 命中中间位
  assert.equal(expand("$3", args).prompt, expectedPrompt("gamma"));
});

test("$3 但只给 2 个参数：缺位 → 空串，不报错不保留字面量", () => {
  const result = expand("a=$1 b=$2 c=$3", "one two");
  assert.equal(result.prompt, expectedPrompt("a=one b=two c="));
});

test("$@ 与 $ARGUMENTS 等价：均为原始 trim 参数串，多处出现全部替换", () => {
  const result = expand("<$@>|<$ARGUMENTS>|<$@>", '  keep "quotes as-is"  ');
  assert.equal(result.prompt, expectedPrompt('<keep "quotes as-is">|<keep "quotes as-is">|<keep "quotes as-is">'));
  assert.equal(result.usedArgumentsPlaceholder, true);
});

test("$@[start:length] 切片：1-based、开区间形态与空串边界", () => {
  const args = "a b c d";
  assert.equal(expand("$@[2]", args).prompt, expectedPrompt("b c d"));
  assert.equal(expand("$@[2:]", args).prompt, expectedPrompt("b c d"));
  assert.equal(expand("$@[1:2]", args).prompt, expectedPrompt("a b"));
  assert.equal(expand("$@[3:9]", args).prompt, expectedPrompt("c d"));
  // start<1 / 越界 / length≤0 → 空串
  assert.equal(expand("$@[0]", args).prompt, expectedPrompt(""));
  assert.equal(expand("$@[99]", args).prompt, expectedPrompt(""));
  assert.equal(expand("$@[2:0]", args).prompt, expectedPrompt(""));
});

test("非法切片形态按备选序回退为 $@ 聚合 + 字面尾巴（与 omp 一致）", () => {
  const args = "a b c";
  // 切片备选不匹配（length 组只收 \d*、start 只收 \d+）时，裸 $@ 备选命中：
  // $@ 替换为参数串，畸形尾巴保持字面。
  assert.equal(expand("$@[2:-1]", args).prompt, expectedPrompt("a b c[2:-1]"));
  assert.equal(expand("$@[a]", args).prompt, expectedPrompt("a b c[a]"));
  // 未闭合切片同理
  assert.equal(expand("$@[2", args).prompt, expectedPrompt("a b c[2"));
});

test("单遍渲染防注入：参数值内的占位符按字面保留且不置 usedArgumentsPlaceholder", () => {
  // 旧两遍实现会把参数值里的 $1 二次展开并吞掉 fallback 追加；单遍化后：
  // $1 → 参数值字面（含 "$ARGUMENTS" 文本），且模板无占位符判定只看模板本身。
  const result = expand("Value: $1", '"$1 $ARGUMENTS $@"');
  assert.equal(result.prompt, expectedPrompt("Value: $1 $ARGUMENTS $@"));
  assert.equal(result.usedArgumentsPlaceholder, true);

  // 模板完全无占位符、参数值含 $1：fallback 照常追加，$1 不被展开
  const fallback = expand("Static body", "$1 $ARGUMENTS");
  assert.equal(
    fallback.prompt,
    expectedPrompt("Static body\n\nUser arguments:\n$1 $ARGUMENTS"),
  );
  assert.equal(fallback.usedArgumentsPlaceholder, false);
});

test("引号分组：单/双引号保留内部空白，空引号参数丢弃", () => {
  const result = expand("$1|$2|$3|$4", `a "b c" '' 'd e'`);
  assert.equal(result.prompt, expectedPrompt("a|b c|d e|"));
  assert.equal(result.argumentCount, 3);
});

test("反斜杠转义保留存量行为（ACode 与 omp 的已记录差异）", () => {
  const result = expand("$1|$2", 'a\\ b "c\\"d"');
  assert.equal(result.prompt, expectedPrompt("a b|c\"d"));
});

test("存量零回归：仅 $ARGUMENTS 模板 / 无占位符 fallback / 骨架与计数", () => {
  const whole = expand("Do this: $ARGUMENTS", "  fix the bug  ");
  assert.equal(whole.prompt, expectedPrompt("Do this: fix the bug"));
  assert.equal(whole.usedArgumentsPlaceholder, true);

  const noArgs = expand("Do this: $ARGUMENTS", "   ");
  assert.equal(noArgs.prompt, expectedPrompt("Do this:"));
  assert.equal(noArgs.argumentCount, 0);

  const plain = expand("Plain body", "some args");
  assert.equal(plain.prompt, expectedPrompt("Plain body\n\nUser arguments:\nsome args"));
  assert.equal(plain.usedArgumentsPlaceholder, false);

  const empty = expand("Plain body", "");
  assert.equal(empty.prompt, expectedPrompt("Plain body"));
});

test("shell 动态展开仍被拒绝（存量守卫不变）", () => {
  assert.throws(() => expand("Run !`date` now", "x"), /unsupported shell expansion/);
  assert.throws(() => expand("```!\nls\n```", "x"), /unsupported shell expansion/);
});

test("skills 指令行与返回骨架不受位置参数影响", () => {
  const result = expandCliCustomCommandPrompt({
    args: "a b",
    command: {
      content: "first=$1 all=$@",
      metadata: { name: "demo", scope: "user", skills: ["verify"], source: "acode" },
    },
  });
  assert.equal(
    result.prompt,
    [
      "Run custom command /demo.",
      "Command source: user/acode.",
      "Required skills: `verify`.",
      "Before following the command body, call the Skill tool for `verify`.",
      "",
      "first=a all=a b",
    ].join("\n"),
  );
});

// ---------------------------------------------------------------
// W1：contracts 第二展开面（bootstrap resolver → desktop-agent/ACP 直提路径）
// 与 cli 面同一单遍语义（specs/slash-positional-args.md W1 同步登记）。
// ---------------------------------------------------------------

const { expandCustomCommandTemplate } = await import(
  "../packages/contracts/src/commands/index.ts"
);

function expandTemplate(content, args) {
  return expandCustomCommandTemplate({ args, command: command(content) });
}

test("contracts 面：$N/$@/$@[start:length]/$ARGUMENTS 与 cli 面同语义", () => {
  assert.equal(expandTemplate("a=$1 b=$2", "one two").body, "a=one b=two");
  assert.equal(expandTemplate("all=$@", "one two three").body, "all=one two three");
  assert.equal(expandTemplate("s=$@[2:2]", "a b c d").body, "s=b c");
  assert.equal(expandTemplate("t=$@[3]", "a b c d").body, "t=c d");
  assert.equal(expandTemplate("w=$ARGUMENTS", " x  y ").body, "w=x  y");
  // 缺位/零长度/越界切片 → 空串（与 cli 面同一裁决）。
  assert.equal(expandTemplate("m=$3", "one two").body, "m=");
  assert.equal(expandTemplate("z=$@[2:0]", "a b").body, "z=");
  assert.equal(expandTemplate("o=$@[9]", "a b").body, "o=");
});

test("contracts 面：单遍渲染——参数值内的占位符按字面保留（注入面已移除）", () => {
  // 旧两遍实现：pass1 把 $ARGUMENTS 换成参数串后，pass2 会把插入值里的 $1 再展开
  // 成 positional[0]（body 变成 cmd=a "a"）；单遍渲染下插入内容不再进扫描，字面保留。
  const injected = expandTemplate("cmd=$ARGUMENTS", 'a "$1"');
  assert.equal(injected.body, 'cmd=a "$1"');
  assert.equal(injected.usedArgumentsPlaceholder, true);
  // 模板自身的占位符照常替换，与参数值内的字面 $1 互不干扰。
  const mixed = expandTemplate("first=$1 rest=$ARGUMENTS", 'a "$2"');
  assert.equal(mixed.body, 'first=a rest=a "$2"');
});

test("contracts 面：无占位符时 User arguments 追加与 argumentCount 行为不变", () => {
  const plain = expandTemplate("Plain body", "some args");
  assert.equal(plain.body, "Plain body\n\nUser arguments:\nsome args");
  assert.equal(plain.usedArgumentsPlaceholder, false);
  assert.equal(plain.argumentCount, 2);
  const withPlaceholder = expandTemplate("x=$ARGUMENTS", "a b");
  assert.equal(withPlaceholder.body, "x=a b");
  assert.equal(withPlaceholder.usedArgumentsPlaceholder, true);
});
