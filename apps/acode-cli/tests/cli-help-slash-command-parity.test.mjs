// `--help` 的斜杠命令目录与权威命令表的一致性。
// 依据：apps/acode-cli/specs/script-workflow-revival.md R10 / 验收场景 35。
//
// 被钉住的缺陷：`acode --help` 里那段 "Slash Commands:" 是 `@acode/i18n` 两个 locale 里各一份
// **硬编码文案**，不从 `BUILTIN_ACODE_SLASH_COMMAND_HELP_ENTRIES` 派生。于是 C1 把 `ultracode`
// 加进权威表之后，`--help` 里根本没有它——第二套工作流系统唯一的用户入口，在用户最先读的
// 那份目录里隐身。`/workflow` 同样缺席，而且缺席得更早（既有状况）：`/dwf`（管理 run）在列，
// 两个**启动** run 的入口却不在，同一族里自相矛盾。
//
// 实测：真实跑 `tsx src/main.ts --help`，Slash Commands 段止于 `/goal`，15 条，无 workflow/ultracode。
//
// 刻意**不**断言两张表全等：`--help` 那段是精选子集，`plugins` 与 `locale` 由 Commands 段与
// Options 段各自承载（`plugins` 是顶层子命令、`locale` 是 `--locale` 选项），把它们塞进
// Slash Commands 段反而会说谎。所以这里只钉两个方向里真正要紧的：
//   - 不得**凭空发明**命令（子集关系）：硬编码表里的每个名字都必须在权威表里；
//   - 工作流这一族必须**齐**：dwf / workflow / ultracode 三个都在场。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BUILTIN_ACODE_SLASH_COMMAND_HELP_ENTRIES } from "../../../packages/shared/src/acode-slash-command-help.ts";

const LOCALES = ["en-US", "zh-CN"];

/** 工作流这一族：一个管理面 + 两个启动入口（分属两套系统）。 */
const WORKFLOW_FAMILY = ["dwf", "workflow", "ultracode"];

function readLocale(locale) {
  return readFileSync(new URL(`../packages/i18n/src/locales/${locale}.ts`, import.meta.url), "utf8");
}

/** 取出 "Slash Commands:" 那一段里列出的命令名（`/name` 形式，忽略参数占位与说明文字）。 */
function helpCommandNames(source) {
  const start = source.indexOf("Slash Commands:");
  assert.ok(start > -1, "locale 里必须有 Slash Commands 段，否则这条测试是空转");
  // 段落终止于模板字符串收尾（反引号）或下一个顶层键；取反引号即可，两个 locale 同构。
  const end = source.indexOf("`", start);
  assert.ok(end > start, "Slash Commands 段必须在模板字符串内收尾");
  const block = source.slice(start, end);
  return [...block.matchAll(/^ {2}\/([a-z-]+)/gm)].map((match) => match[1]);
}

test("权威表里工作流这一族有三条，且用法文案点名了两套系统的区别", () => {
  const names = BUILTIN_ACODE_SLASH_COMMAND_HELP_ENTRIES.map((entry) => entry.name);
  for (const name of WORKFLOW_FAMILY) {
    assert.ok(names.includes(name), `权威表缺 ${name}`);
  }
  const ultracode = BUILTIN_ACODE_SLASH_COMMAND_HELP_ENTRIES.find(
    (entry) => entry.name === "ultracode",
  );
  // details 的第一条必须把「这是另一套系统」说穿，否则用户会以为它只是 /workflow 的别名。
  assert.ok(
    ultracode.details.some((line) => line.includes("other workflow system")),
    "ultracode 的 details 必须点明它与 /workflow 是两套不同系统",
  );
});

for (const locale of LOCALES) {
  test(`${locale}：--help 不得凭空发明命令（必须是权威表的子集）`, () => {
    const authoritative = new Set(
      BUILTIN_ACODE_SLASH_COMMAND_HELP_ENTRIES.map((entry) => entry.name),
    );
    const listed = helpCommandNames(readLocale(locale));
    assert.ok(listed.length > 0, "解析出 0 条说明提取正则失效了，不是真的没有命令");
    const invented = listed.filter((name) => !authoritative.has(name));
    assert.deepEqual(
      invented,
      [],
      `--help 列出了权威表里没有的命令：${invented.join(", ")}。` +
        "硬编码文案与命令表漂移了——要么补进权威表，要么从 --help 删掉",
    );
  });

  test(`${locale}：--help 必须列全工作流这一族（dwf / workflow / ultracode）`, () => {
    const listed = new Set(helpCommandNames(readLocale(locale)));
    const missing = WORKFLOW_FAMILY.filter((name) => !listed.has(name));
    assert.deepEqual(
      missing,
      [],
      `--help 的 Slash Commands 段缺：${missing.join(", ")}。` +
        "启动入口不在目录里，等于这套系统对用户不可发现——/dwf 在列而两个启动入口不在，" +
        "同一族里自相矛盾",
    );
  });
}

test("两个 locale 的 --help 命令集合一致（否则中英文用户看到的目录不同）", () => {
  const [first, second] = LOCALES.map((locale) => helpCommandNames(readLocale(locale)).sort());
  assert.deepEqual(first, second, "两个 locale 必须列出同一批命令");
});
