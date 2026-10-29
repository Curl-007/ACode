// Desktop 端本地诊断（U12）验收测试。
// spec: packages/desktop/specs/local-diagnostic-report-desktop.md，
// 契约真源: packages/shared/specs/local-diagnostic-report.md。
// 不启动 Electron：dialog/fs 全注入；采集依赖注入（版本常量在测试环境恒为回退值）。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localDiagnosticFactsSchema } from "@acode/shared";
import {
  DIAGNOSTIC_SAVE_TOO_LARGE,
  DIAGNOSTIC_SAVE_WRITE_FAILED,
  collectDesktopDiagnosticFacts,
  saveDiagnosticReport,
} from "../src/main/localDiagnostics.js";

/** 记录 warn 调用的假 logger（断言原始异常只进日志、不回传调用方）。 */
function fakeLogger() {
  const warnings = [];
  return { warnings, logger: { warn: (...args) => warnings.push(args), info: () => {} } };
}

test("U12-A2: 采集产出 schema 合法的 facts，且带 Desktop 独有的 os/arch", () => {
  const facts = collectDesktopDiagnosticFacts({
    locale: () => "zh-CN",
    // 注入真实版本值：测试环境无 define 注入，常量恒为回退值，故必须注入才能覆盖「版本在场」路径。
    buildVersion: () => "1.0.4",
    buildCommit: () => "abc1234",
    os: () => "win32",
    arch: () => "x64",
  });
  const parsed = localDiagnosticFactsSchema.parse(facts); // 不抛即合法
  assert.equal(parsed.platformType, "desktop");
  assert.equal(parsed.build?.os, "win32");
  assert.equal(parsed.build?.arch, "x64");
  assert.equal(parsed.build?.appVersion, "1.0.4");
  assert.equal(parsed.build?.commit, "abc1234");
  assert.equal(parsed.build?.locale, "zh-CN");
  assert.equal(parsed.buildAvailability, "collected");
  // main 不持有连接层状态 → 诚实标 unavailable 且组缺席（不猜测、不伪造）
  assert.equal(parsed.connectionAvailability, "unavailable");
  assert.equal(parsed.connection, undefined);
});

test("U12-A4: 非事实版本回退值被省略（不得声称假版本）", () => {
  for (const [version, commit] of [
    ["0.0.0-dev", "unknown"],
    ["", ""],
    [undefined, undefined],
  ]) {
    const facts = collectDesktopDiagnosticFacts({
      locale: () => "en-US",
      buildVersion: () => version,
      buildCommit: () => commit,
      os: () => "linux",
      arch: () => "arm64",
    });
    assert.equal(facts.build?.appVersion, undefined, `version=${String(version)} 应被省略`);
    assert.equal(facts.build?.commit, undefined, `commit=${String(commit)} 应被省略`);
    // os/arch/locale 仍是事实，照常上报 → build 组保持 collected
    assert.equal(facts.buildAvailability, "collected");
    assert.equal(facts.build?.os, "linux");
  }
});

test("U12-A2/A3: facts 不含 hostname/用户名/原始路径/凭据形状（白名单结构性排除）", () => {
  // about.ts 的 AboutSnapshot 含 hostname——本模块刻意不复用该快照。
  // 用一个「充满敏感值的环境」证明采集面根本不读这些：注入的 locale/os/arch 都是安全值，
  // 断言输出键集封闭 + 无敏感子串。
  const facts = collectDesktopDiagnosticFacts({
    locale: () => "zh-CN",
    buildVersion: () => "1.0.4",
    buildCommit: () => "abc1234",
    os: () => "win32",
    arch: () => "x64",
  });
  const serialized = JSON.stringify(facts);
  for (const forbidden of [
    "hostname",
    "Bearer ",
    "authorization",
    "apiKey",
    "password",
    "C:\\Users\\",
    "/home/",
  ]) {
    assert.ok(
      !serialized.toLowerCase().includes(forbidden.toLowerCase()),
      `facts 含敏感形状: ${forbidden}`,
    );
  }
  // 键集封闭：build 组只有 schema 允许的字段
  assert.deepEqual(Object.keys(facts.build).sort(), [
    "appVersion",
    "arch",
    "capabilities",
    "commit",
    "locale",
    "os",
  ]);
  assert.deepEqual(Object.keys(facts).sort(), [
    "build",
    "buildAvailability",
    "connectionAvailability",
    "platformType",
  ]);
});

test("U12-A5: 保存成功——写入的字节与入参逐字节相同（main 是哑 sink，不改写）", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "acode-diag-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, "report.json");
  const json = JSON.stringify({ schemaVersion: 1, platformType: "desktop", 中文: "值" });
  const { logger } = fakeLogger();

  const result = await saveDiagnosticReport(json, "report.json", {
    showSaveDialog: async () => ({ canceled: false, filePath: target }),
    logger,
  });

  assert.equal(result.saved, true);
  assert.equal(result.path, target);
  assert.equal(await readFile(target, "utf-8"), json); // 逐字节相同，含中文未被转义/改写
});

test("U12-A5: 用户取消保存框 → cancelled:true 且不写文件（取消不是错误）", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "acode-diag-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { logger, warnings } = fakeLogger();
  let wrote = false;

  const result = await saveDiagnosticReport("{}", "report.json", {
    // canceled 且无 filePath（Electron 取消时的真实形态）
    showSaveDialog: async () => {
      wrote = true;
      return { canceled: true };
    },
    logger,
  });

  assert.equal(result.saved, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.error, undefined, "取消不应带错误码");
  assert.equal(wrote, true, "对话框确实被展示过");
  assert.equal(warnings.length, 0, "取消不记 warn");
});

test("U12-A5: 写盘失败 → 稳定码，原始异常只进日志不回传（不泄漏用户路径）", async () => {
  const { logger, warnings } = fakeLogger();
  // 跨平台写失败模拟：tmpdir 下必不存在的子目录 → 两个平台都稳定 ENOENT。
  // 旧写法用盘符反斜杠路径（Windows 上 ENOENT），但 Linux 上该形态是合法相对文件名，
  // writeFile 会在 cwd 真实写成功（saved:true），测试意图整体失效——CI Linux 红的根因，
  // 本地 Windows 门禁与 Windows CI（不跑 desktop 包）都掩盖了它。
  const secretPath = join(tmpdir(), "acode-diag-SecretUser-missing", "报告.json");

  const result = await saveDiagnosticReport("{}", "report.json", {
    showSaveDialog: async () => ({ canceled: false, filePath: secretPath }),
    logger,
  });
  // 上面的 dialog 返回一个不存在目录的路径 → writeFile 失败（ENOENT）
  assert.equal(result.saved, false);
  assert.equal(result.error, DIAGNOSTIC_SAVE_WRITE_FAILED);
  // 关键：返回体不含原始错误消息（其中带用户路径标记段）
  assert.ok(!JSON.stringify(result).includes("SecretUser"), "错误码回传泄漏了用户路径");
  assert.ok(!result.error.includes("ENOENT"));
  // 但原始异常确实进了 main 日志（可诊断）
  assert.equal(warnings.length, 1);
});

test("U12-A5: 超 1 MiB 拒绝保存且不弹保存框（避免让用户选完路径才失败）", async () => {
  const { logger, warnings } = fakeLogger();
  let dialogShown = false;
  const oversized = "x".repeat(1024 * 1024 + 10);

  const result = await saveDiagnosticReport(oversized, "report.json", {
    showSaveDialog: async () => {
      dialogShown = true;
      return { canceled: false, filePath: "should-not-be-used.json" };
    },
    logger,
  });

  assert.equal(result.saved, false);
  assert.equal(result.error, DIAGNOSTIC_SAVE_TOO_LARGE);
  assert.equal(dialogShown, false, "超限应在弹框前拒绝");
  // 日志只记数值不记内容（内容可能含用户数据）
  assert.equal(warnings.length, 1);
  assert.ok(!JSON.stringify(warnings[0]).includes("xxxxx"));
});

test("字节长度按 UTF-8 计（中文报告不会因字符数低估而漏判超限）", async () => {
  const { logger } = fakeLogger();
  // 每个中文字符 3 字节：约 35 万字符 ≈ 1.05 MiB，字符数远小于 1MiB 但字节数已超
  const chinese = "报".repeat(350_000);
  assert.ok(chinese.length < 1024 * 1024, "前提：字符数低于上限");

  const result = await saveDiagnosticReport(chinese, "report.json", {
    showSaveDialog: async () => ({ canceled: false, filePath: "unused.json" }),
    logger,
  });
  assert.equal(result.error, DIAGNOSTIC_SAVE_TOO_LARGE, "按字符数判断会漏过这份超限报告");
});
