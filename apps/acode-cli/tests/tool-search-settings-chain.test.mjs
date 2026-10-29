import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * 波 1c 设置链的 CLI 参数面 + bootstrap 物化链钉住（specs/tool-search.md R1/R3/R11）。
 *
 * 断言分两类（仓库既有惯例，见 packages/services/test/scriptWorkflowModeFieldChain.test.ts）：
 *   - parseGlobalArgs 是轻量纯函数（仅依赖 node:util），行为直测：四值透传、缺省不覆盖；
 *   - run.ts 的 normalizeToolSearchMode 与各入口传递是模块私有/装配接线，源码断言钉住
 *     「非法值启动报错、未传不覆盖、全入口传递」三条语义分支还在不在。
 */

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const { parseGlobalArgs } = await import("../packages/cli/src/arguments.ts");

test("parseGlobalArgs：--toolsearch-mode 注册为 string 选项并原样透传", () => {
  const parsed = parseGlobalArgs(["--toolsearch-mode", "local", "-p", "hi"]);
  assert.equal(parsed.values["toolsearch-mode"], "local");
});

test("parseGlobalArgs：未传 --toolsearch-mode 时值为 undefined（缺席 = 不覆盖 = off）", () => {
  const parsed = parseGlobalArgs(["-p", "hi"]);
  assert.equal(parsed.values["toolsearch-mode"], undefined);
});

test("run.ts：四值域含 native、非法值抛错、入口 stderr+exit 1、globalOptions 条件展开", async () => {
  const source = await read("packages/cli/src/run.ts");
  assert.match(
    source,
    /const TOOL_SEARCH_CLI_MODES = \["auto", "native", "local", "off"\] as const;/,
    "CLI 四值域（native 仅 CLI 显式传入，波 1 执行期报错）",
  );
  assert.match(
    source,
    /throw new Error\(\s*`Unsupported --toolsearch-mode value: /,
    "非法值必须抛错（不静默降级）",
  );
  assert.match(
    source,
    /normalizeToolSearchMode\(parsed\.values\["toolsearch-mode"\][\s\S]{0,300}?ctx\.stderr\.write[\s\S]{0,120}?return 1;/,
    "run() 入口必须捕获非法值：stderr 报错 + 退出码 1（与 --browser-use 同款）",
  );
  assert.match(
    source,
    /if \(value === undefined\) return undefined;/,
    "未传 = undefined = 不覆盖（缺席即 off 的启动参数面表达）",
  );
  assert.match(
    source,
    /\.\.\.\(toolSearchMode \? \{ toolSearchMode \} : \{\}\)/,
    "globalOptions 条件展开：undefined 不写键",
  );
});

test("入口传递：prompt/target（prompt-command）与 TUI（tui-command/tui-prompt-handler）都写进 runtimeConfig", async () => {
  const promptCommand = await read("packages/cli/src/prompt-command.ts");
  assert.match(
    promptCommand,
    /\.\.\.\(options\.toolSearchMode \? \{ toolSearchMode: options\.toolSearchMode \} : \{\}\)/,
    "headless prompt/target 入口：显式值写进 runtimeConfig（--resume/--continue 同走本 config）",
  );
  const tuiCommand = await read("packages/cli/src/tui-command.ts");
  assert.match(
    tuiCommand,
    /options\.toolSearchMode,/,
    "TUI 入口必须把 options.toolSearchMode 传给 createTuiSubmitPrompt",
  );
  const tuiHandler = await read("packages/cli/src/tui-prompt-handler.ts");
  assert.match(
    tuiHandler,
    /toolSearchMode\?: GlobalOptions\["toolSearchMode"\]/,
    "createTuiSubmitPrompt 必须声明 toolSearchMode 参数",
  );
  assert.match(
    tuiHandler,
    /\.\.\.\(toolSearchMode \? \{ toolSearchMode \} : \{\}\)/,
    "TUI createApp 的 runtimeConfig 条件写入（存活期换 App 沿用同一 CLI 启动值）",
  );
  // CLI 显式值优先于物化设置：CLI 直连 createApp 的 runtimeConfig 就是唯一来源，
  // Host 设置链只存在于 v4 createSession 信封（bootstrap 侧），两条路不交叉。
  assert.ok(
    !promptCommand.includes("settingService") && !tuiHandler.includes("settingService"),
    "CLI 独立运行不读 App 设置（R1）：入口文件不得出现 settingService",
  );
});

test("i18n：--toolsearch-mode 进双语 help 文案", async () => {
  for (const locale of ["en-US", "zh-CN"]) {
    const source = await read(`packages/i18n/src/locales/${locale}.ts`);
    assert.ok(
      source.includes("--toolsearch-mode"),
      `${locale} help 必须登记 --toolsearch-mode`,
    );
  }
});

test("bootstrap 物化链：v4 createSession payload → createSessionRecord → runtimeFlags 侧通道 → runtimeConfig", async () => {
  const sessionMgmt = await read(
    "packages/bootstrap/src/acode-protocol-v4/commands/handlers/session-mgmt.ts",
  );
  assert.match(
    sessionMgmt,
    /toolSearchMode: payload\.toolSearchMode,/,
    "v4 createSession handler 必须把 payload.toolSearchMode 传给 host.createSessionRecord",
  );

  const v4Bridge = await read("packages/bootstrap/src/acode-protocol-v4/v4-binder.ts");
  assert.match(
    v4Bridge,
    /\}, \{ scriptWorkflowEnabled, toolSearchMode, clientMode \}\);/,
    "v4-bridge 必须经 runtimeFlags 侧通道下传（legacy strict params 不收新键）；" +
      "clientMode 是 U11 同款侧通道新增键（specs/tool-media-attachment-ref.md R10.2a）",
  );
  assert.match(
    v4Bridge,
    /if \(toolSearchMode !== undefined\) \{\s*\n\s*context\.appRuntimePreferences\.toolSearchMode = toolSearchMode;/,
    "createSession 时机必须刷新进程级兜底缓存（冷恢复/fork 路径回读）",
  );

  const serverOperations = await read("packages/bootstrap/src/acode-protocol-v4/server-operations.ts");
  assert.match(
    serverOperations,
    /const resolvedToolSearchMode =\s*\n?\s*runtimeFlags\?\.toolSearchMode \?\? context\.appRuntimePreferences\.toolSearchMode;/,
    "createRecord 折叠：侧通道优先，缺席回读进程缓存（冷恢复/fork 兜底）",
  );
  assert.match(
    serverOperations,
    /\.\.\.\(resolvedToolSearchMode === undefined \? \{\} : \{ toolSearchMode: resolvedToolSearchMode \}\)/,
    "runtimeConfig 条件写入：两者都无 = 不写字段 = core 按缺席即 off（零行为变化红线）",
  );

  const serverTypes = await read("packages/bootstrap/src/acode-protocol-v4/server-types.ts");
  assert.match(
    serverTypes,
    /toolSearchMode\?: ToolSearchAppMode;/,
    "appRuntimePreferences 必须登记 toolSearchMode（缺省 undefined = off，fail-safe）",
  );
});
