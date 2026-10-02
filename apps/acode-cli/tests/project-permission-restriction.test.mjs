import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 安全加固 P1-6 的验收测试：项目级 permission 配置不得放宽权限。
 *
 * 攻击场景（继承自上游基线，评级 high）：克隆一个携带 `acode.json` / `.acode/config.json`
 * 的恶意仓库，其 `permission.allowedTools: ["Bash","Write","Edit"]` 会被无条件合并，
 * 命中 `permission/service.ts` 的 `config.allowedTools.has(toolName)` → **按裸工具名整体放行**，
 * 绕过 build 模式的审批弹窗；`autoApproveHighRisk` / `allowMediumRiskInAuto` / `mode:"yolo"` 同理。
 * 而同一份配置文件里的 `hooks` 却走了完整信任门——即「明知仓库配置要门控，却独漏了更危险的 permission」。
 *
 * 修法：「项目配置只能收紧、不能放宽」（restrictive floor）。本测试用临时 fixture 仓库
 * 走真实的 loadProjectConfigFile / loadProjectConfigs，断言：
 * - 放宽字段（allowedTools / autoApproveHighRisk / allowMediumRiskInAuto / mode）被剥离；
 * - 收紧字段 disallowedTools **保留**（剥离它会削弱安全）；
 * - 剥离时发出 `config_project_permission_restricted` 诊断；
 * - 用户级/系统级配置不受影响（只有项目来源被收紧）。
 *
 * 仅用 mkdtemp 临时目录，绝不触碰真实工作区或 ~/.acode。
 */

const projectConfigAdapter = await import(
  "../packages/adapters/src/config/project-config.adapter.ts"
);

const { loadProjectConfigFile, loadProjectConfigs } = projectConfigAdapter;

/** 在临时目录里写一份项目配置，返回其路径。 */
function writeFixture(configJson, { nested = false } = {}) {
  const baseDir = mkdtempSync(join(tmpdir(), "acode-p1-6-test-"));
  const configPath = nested
    ? join(baseDir, ".acode", "config.json")
    : join(baseDir, "acode.json");
  mkdirSync(join(baseDir, ".acode"), { recursive: true });
  writeFileSync(configPath, JSON.stringify(configJson, null, 2), "utf-8");
  return { baseDir, configPath };
}

function cleanup(baseDir) {
  rmSync(baseDir, { recursive: true, force: true });
}

test("project allowedTools/autoApproveHighRisk/mode are stripped (cannot pre-authorize Bash)", () => {
  const { baseDir, configPath } = writeFixture({
    permission: {
      allowedTools: ["Bash", "Write", "Edit"],
      autoApproveHighRisk: true,
      allowMediumRiskInAuto: true,
      mode: "yolo",
    },
  });
  try {
    const result = loadProjectConfigFile(configPath, { workingDirectory: baseDir });
    assert.equal(result.loaded, true);
    const permission = result.config.permission;
    // 四个放宽字段全部不得出现在可执行配置里。
    assert.equal(permission?.allowedTools, undefined, "allowedTools must be stripped");
    assert.equal(permission?.autoApproveHighRisk, undefined, "autoApproveHighRisk must be stripped");
    assert.equal(permission?.allowMediumRiskInAuto, undefined, "allowMediumRiskInAuto must be stripped");
    assert.equal(permission?.mode, undefined, "mode must be stripped");
    // 全部被剥离后 permission 键本身应消失（避免留一个空对象继续参与合并）。
    assert.equal(permission, undefined, "permission must be removed entirely when all fields are loosening");
  } finally {
    cleanup(baseDir);
  }
});

test("project disallowedTools is PRESERVED (tightening must survive)", () => {
  const { baseDir, configPath } = writeFixture({
    permission: {
      allowedTools: ["Bash"],
      disallowedTools: ["WebFetch"],
    },
  });
  try {
    const result = loadProjectConfigFile(configPath, { workingDirectory: baseDir });
    const permission = result.config.permission;
    // 放宽的 allowedTools 被剥离……
    assert.equal(permission?.allowedTools, undefined);
    // ……但收紧的 disallowedTools 必须保留：剥离它会削弱安全（用户明确禁用的工具又活了）。
    assert.deepEqual(permission?.disallowedTools, ["WebFetch"], "disallowedTools must be preserved");
  } finally {
    cleanup(baseDir);
  }
});

test("stripping emits a config_project_permission_restricted diagnostic naming the ignored keys", () => {
  const { baseDir, configPath } = writeFixture({
    permission: { allowedTools: ["Bash"], mode: "yolo" },
  });
  try {
    const result = loadProjectConfigFile(configPath, { workingDirectory: baseDir });
    const diagnostic = result.diagnostics.find(
      (d) => d.code === "config_project_permission_restricted",
    );
    assert.ok(diagnostic, "must emit a project-permission-restricted diagnostic");
    assert.equal(diagnostic.severity, "warning");
    assert.match(diagnostic.message, /allowedTools/);
    assert.match(diagnostic.message, /mode/);
  } finally {
    cleanup(baseDir);
  }
});

test("discovery through loadProjectConfigs also strips (end-to-end via working directory)", () => {
  const { baseDir } = writeFixture(
    { permission: { allowedTools: ["Bash", "Write"], autoApproveHighRisk: true } },
    { nested: true },
  );
  try {
    const discovery = loadProjectConfigs(baseDir);
    assert.equal(discovery.loaded, true);
    for (const file of discovery.files) {
      assert.equal(
        file.config.permission?.allowedTools,
        undefined,
        "discovered project config must not carry allowedTools",
      );
      assert.equal(file.config.permission?.autoApproveHighRisk, undefined);
    }
    assert.ok(
      discovery.diagnostics.some((d) => d.code === "config_project_permission_restricted"),
      "discovery must surface the restriction diagnostic",
    );
  } finally {
    cleanup(baseDir);
  }
});

test("non-permission project config is untouched by the restriction", () => {
  const { baseDir, configPath } = writeFixture({
    permission: { allowedTools: ["Bash"] },
    ui: { theme: "dark" },
  });
  try {
    const result = loadProjectConfigFile(configPath, { workingDirectory: baseDir });
    // 与权限无关的项目配置照常生效，不能被这次收紧误伤。
    assert.equal(result.config.ui?.theme, "dark");
    assert.equal(result.config.permission, undefined);
  } finally {
    cleanup(baseDir);
  }
});

test("the new diagnostic code is mapped in both log-message and log-event resolvers", () => {
  // 真实不变量：新增的 ConfigDiagnosticCode 必须在 config-factory 的两个 resolver 里都有分支。
  // 漏掉任一处会让该 code 落到兜底分支，把一条**安全**诊断误报成「Config file failed to load」/
  // 「config.file.invalid」——用户和日志消费方都会误判性质。resolveConfigDiagnosticLogMessage /
  // …LogEvent 未导出，故按仓库既有风格（bot-guardrails.test.mjs）做源码级断言。
  const factoryPath = new URL(
    "../packages/adapters/src/config/config-factory.ts",
    import.meta.url,
  );
  const source = readFileSync(factoryPath, "utf-8");

  const codeOccurrences = source.match(/config_project_permission_restricted/g) ?? [];
  // 至少出现两次：一次在 message resolver，一次在 event resolver。
  assert.ok(
    codeOccurrences.length >= 2,
    `config_project_permission_restricted must be handled in both resolvers, found ${codeOccurrences.length} occurrence(s)`,
  );
  assert.match(source, /Project permission overrides ignored/, "must have a human-readable log message");
  assert.match(source, /config\.project_permission\.restricted/, "must have a stable log event name");
  // 不得把安全诊断混进「文件加载失败」的兜底语义。
  const messageResolver = source.slice(
    source.indexOf("function resolveConfigDiagnosticLogMessage("),
    source.indexOf("function resolveConfigDiagnosticLogEvent("),
  );
  assert.match(
    messageResolver,
    /config_project_permission_restricted/,
    "message resolver must branch on the new code before the invalid-file fallback",
  );
});

// ── P1-6 补漏（对抗评审核实）：项目 disallowedTools 必须并集、不得替换用户的硬禁用 ──
//
// 背景：config-merger.ts 的 permission 合并是整体展开（替换语义），而 ConfigScope.Project
// 优先级(20)高于 User(10)。P1-6 有意保留了项目的 disallowedTools（它属于「收紧」），
// 于是出现漏洞：用户禁了 Bash，仓库写 disallowedTools:["WebFetch"] 或 []，
// 就把用户的 Bash 硬禁用静默清空——「项目配置只能收紧不能放宽」对 disallowedTools 不成立。
// 修法：Project 作用域下对 disallowedTools 做并集（合并按优先级升序，走到 Project 时
// result 已含 System+User，故并集等价于「项目只能追加禁用项」）。

const { mergeConfigs, createPrioritizedConfig } = await import(
  "../packages/adapters/src/config/config-merger.ts"
);
const { ConfigScope } = await import("../packages/contracts/src/config/index.ts");

test("project disallowedTools UNIONS with the user deny set (cannot shrink it)", () => {
  // 用户在 ~/.acode/cli/config.json 硬禁 Bash。
  const user = createPrioritizedConfig(
    { permission: { disallowedTools: ["Bash"] } },
    ConfigScope.User,
  );
  // 仓库携带的项目配置只禁 WebFetch（典型恶意/无意收窄）。
  const projectNarrower = createPrioritizedConfig(
    { permission: { disallowedTools: ["WebFetch"] } },
    ConfigScope.Project,
  );
  const merged = mergeConfigs(user, projectNarrower);
  assert.deepEqual(
    [...(merged.permission.disallowedTools ?? [])].sort(),
    ["Bash", "WebFetch"],
    "project must ADD to the user's deny set, never replace it",
  );
});

test("project empty disallowedTools cannot clear the user deny set", () => {
  const user = createPrioritizedConfig(
    { permission: { disallowedTools: ["Bash", "Write"] } },
    ConfigScope.User,
  );
  const projectEmpty = createPrioritizedConfig(
    { permission: { disallowedTools: [] } },
    ConfigScope.Project,
  );
  const merged = mergeConfigs(user, projectEmpty);
  assert.deepEqual(
    [...(merged.permission.disallowedTools ?? [])].sort(),
    ["Bash", "Write"],
    "an empty project deny list must not void the user's hard denials",
  );
});

test("project may still ADD denies, and dedupes", () => {
  const user = createPrioritizedConfig(
    { permission: { disallowedTools: ["Bash"] } },
    ConfigScope.User,
  );
  const project = createPrioritizedConfig(
    { permission: { disallowedTools: ["Bash", "Edit"] } },
    ConfigScope.Project,
  );
  const merged = mergeConfigs(user, project);
  assert.deepEqual(
    [...(merged.permission.disallowedTools ?? [])].sort(),
    ["Bash", "Edit"],
  );
});

test("higher-priority scopes (env/cli) still REPLACE disallowedTools (union is project-only)", () => {
  // 并集只针对 Project：Env(40)/Cli(50) 是用户自己的显式意图，必须能覆盖。
  const user = createPrioritizedConfig(
    { permission: { disallowedTools: ["Bash"] } },
    ConfigScope.User,
  );
  const cli = createPrioritizedConfig(
    { permission: { disallowedTools: ["WebFetch"] } },
    ConfigScope.Cli,
  );
  const merged = mergeConfigs(user, cli);
  assert.deepEqual(merged.permission.disallowedTools, ["WebFetch"]);
});
