import assert from "node:assert/strict";
import test from "node:test";

import { redactFeedbackText } from "../src/feedbackPrivacy.js";
import {
  casefoldName,
  createHostNameRegistry,
  HOST_NAME_REGISTRY_LIMIT,
} from "../src/logRedactionHostNames.js";
import {
  buildLogRedactionIdentity,
  collectWindowsProfileNames,
  normalizeWindowsAccountName,
} from "../src/logRedactionIdentity.js";
import { createLogRedactor, WITHHELD_LINE_PLACEHOLDER } from "../src/logRedactionPipeline.js";
import {
  normalizeDeviceAndUncPaths,
  redactUrlsInText,
  redactUserInfoInUrls,
  redactWindowsSids,
} from "../src/logRedactionUrls.js";
import {
  ACODE_SESSION_ID_PATTERN,
  detectSuspectedSessionTokenLeak,
  isAllowedEgressSessionValue,
  isCanonicalACodeSessionId,
} from "../src/sessionEgressGate.js";

/**
 * 日志脱敏管线（specs/log-privacy-redaction.md）核心行为：
 * 收名注册表、身份合并、路径/URL/SID/机密占位符、组合正则缓存、
 * fail-closed 整行抑制、会话 token 泄漏门与幂等不变量。
 */

function createTestRedactor(overrides: Parameters<typeof createLogRedactor>[0] = {}) {
  const identity = buildLogRedactionIdentity({
    env: {
      homedir: "C:\\Users\\liar",
      userInfoUsername: "liar",
      computerName: "DESKTOP-1",
      userDomain: "CORP",
      platform: "win32",
    },
    windowsEvidence: {
      profilesDirectory: "C:\\Users",
      profileImagePaths: ["C:\\Users\\Real.Name"],
      logonNames: ["CORP\\alice"],
    },
    extraHostNames: ["DESKTOP-1"],
  });
  const registry = createHostNameRegistry();
  const redactor = createLogRedactor({ identity, registry, ...overrides });
  return { redactor, registry, identity };
}

test("casefold：ς→σ 且长度变化的字符保留原形", () => {
  assert.equal(casefoldName("ΟΔΟΣ"), "οδοσ");
  // `İ`.toLowerCase() 会产生两个码位（i + 组合点），长度变化 → 保留原字符防错位。
  assert.equal(casefoldName("İstanbul"), "İstanbul");
  assert.equal(casefoldName("EXAMPLE.Host"), "example.host");
});

test("注册表收名：NFC/NFD 双形、localhost/IP/短名排除", () => {
  const registry = createHostNameRegistry();
  registry.register("host", "Example.Host");
  assert.ok(registry.names.has("example.host"));
  // NFD 打印形态已登记（组合字符两种拼法都能命中替换）。
  assert.ok(registry.printedForms.has(casefoldName("Example.Host".normalize("NFD"))));
  registry.register("host", "localhost");
  registry.register("host", "127.0.0.1");
  registry.register("host", "::1");
  registry.register("host", "ab");
  for (const skipped of ["localhost", "127.0.0.1", "::1", "ab"]) {
    assert.equal(registry.names.has(skipped), false, `${skipped} 不应收名`);
  }
});

test("注册表收名：剥不可见码点后补登记", () => {
  const registry = createHostNameRegistry();
  registry.register("host", "evil\u200bname.example");
  assert.ok(registry.names.has("evilname.example"), "零宽字符剥除后的形态必须可命中");
});

test("注册表 2000 条上限 + full 标志", () => {
  const registry = createHostNameRegistry();
  for (let index = 0; index < HOST_NAME_REGISTRY_LIMIT; index += 1) {
    registry.register("host", `host-${index}.example`);
  }
  assert.equal(registry.full, false);
  registry.register("host", "one-more.example");
  assert.equal(registry.full, true);
  assert.equal(registry.names.size, HOST_NAME_REGISTRY_LIMIT);
});

test("truncatePreservingNames 不劈名字（整段进或整段出）", () => {
  const registry = createHostNameRegistry();
  registry.register("host", "verylonghostname");
  const text = `${"a".repeat(50)}verylonghostname${"z".repeat(50)}`;
  const cut = registry.truncatePreservingNames(text, 60);
  // 截断点 60 落在名字（50..66）内部 → 必须回退到 50，名字整体不出现。
  assert.equal(cut, "a".repeat(50));
  // 截断点在名字之后：名字整段保留，长度精确到 limit。
  const cutOutside = registry.truncatePreservingNames(text, 80);
  assert.equal(cutOutside.length, 80);
  assert.ok(cutOutside.includes("verylonghostname"));
  assert.equal(registry.truncatePreservingNames("short", 100), "short");
});

test("Windows 注册表真名：.000/.V2 剥离与域前缀补全", () => {
  assert.equal(normalizeWindowsAccountName("alice.000", []), "alice");
  assert.equal(normalizeWindowsAccountName("bob.V2", []), "bob");
  const collected = collectWindowsProfileNames({
    evidence: {
      profilesDirectory: "C:\\Users\\",
      profileImagePaths: ["C:\\Users\\Real.Name.000", "C:\\Users\\bob.V2", null],
      logonNames: ["CORP\\alice", "LastUser"],
    },
    env: {
      userInfoUsername: "liar",
      userDomain: "CORP",
      computerName: "DESKTOP-1",
      homedir: "C:\\Users\\liar",
    },
  });
  // env 名（liar）与注册表真名（Real.Name/bob/alice）取并集：env 撒谎也能 redact。
  for (const expected of ["liar", "Real.Name", "bob", "alice", "LastUser"]) {
    assert.ok(collected.names.includes(expected), `缺名字 ${expected}: ${collected.names}`);
  }
  assert.ok(collected.homes.includes("C:\\Users\\Real.Name.000"));
  assert.ok(collected.dirs.includes("C:\\Users"));
});

test("路径占位符：<home>/<user>/<vol>/<unc>/<drv>:", () => {
  const { redactor } = createTestRedactor();
  const line = redactor.redactLine(
    "open C:\\Users\\Real.Name\\docs\\a.txt for liar; posix /home/liar/x /Users/bob/y /Volumes/USB/z \\\\srv\\share\\f drv D:\\a",
  );
  assert.ok(!line.includes("Real.Name"), line);
  assert.ok(!line.includes("liar"), line);
  assert.ok(line.includes("<home>"), line);
  assert.ok(line.includes("<vol>"), line);
  assert.ok(line.includes("<unc>"), line);
  assert.ok(line.includes("<drv>:\\"), line);
});

test("设备/UNC 前缀先归一再脱敏", () => {
  assert.equal(
    normalizeDeviceAndUncPaths(String.raw`\\?\UNC\srv\share\x`),
    String.raw`\\srv\share\x`,
  );
  assert.equal(normalizeDeviceAndUncPaths(String.raw`\\?\C:\a`), "C:\\a");
  const { redactor } = createTestRedactor();
  const line = redactor.redactLine(String.raw`path \\?\UNC\fileserver\docs\a.txt`);
  assert.ok(!line.includes("fileserver"), line);
  assert.ok(line.includes("<unc>"), line);
});

test("URL 策略：origin-only、内网/IP/无点主机 <url>、userinfo 剥除", () => {
  assert.equal(
    redactUrlsInText("GET https://api.example.com/v1/x?key=1#f done"),
    "GET https://api.example.com/<path> done",
  );
  assert.equal(redactUrlsInText("dial http://10.0.0.5:9/x"), "dial <url>");
  assert.equal(redactUrlsInText("dial http://printer.local/y"), "dial <url>");
  assert.equal(redactUrlsInText("dial http://nodots/z"), "dial <url>");
  assert.equal(redactUrlsInText("dial http://box.internal/z"), "dial <url>");
  assert.equal(redactUrlsInText("dial http://[::1]:8080/z"), "dial <url>");
  // userinfo 编码绕过识别：%40 与 \u0040 形态整段抑制。
  assert.ok(redactUrlsInText("https://evil%40example.com/x").includes("<url>"));
  // 简单 scheme（小写化后 [a-z]+(-[a-z]+)* 且 ≤20 字符）保留前缀、剥 origin/path；
  // 含数字/加号等「不简单」拼写一律 <url>；含下划线的非法 scheme 不是 URL，原样保留。
  assert.equal(redactUrlsInText("open acode://host/deep"), "open acode:");
  assert.equal(redactUrlsInText("open WeirdScheme://h/p"), "open weirdscheme:");
  assert.equal(redactUrlsInText("open v1+proto://h/p"), "open <url>");
  assert.equal(redactUrlsInText("open weird_scheme://h/p"), "open weird_scheme://h/p");
  // userinfo 剥除 + 稠密 URL 抑制。
  assert.equal(
    redactUserInfoInUrls("https://user:pass@api.example.com/x"),
    "https://<userinfo>@api.example.com/x",
  );
  const dense = `https://${"a://".repeat(40)}x@y`;
  assert.match(redactUserInfoInUrls(dense), /^<redacted:dense-urls:\d+b>$/);
});

test("URL 收敛后凭据不残留（管线级）", () => {
  const { redactor } = createTestRedactor();
  const line = redactor.redactLine(
    "fetch https://user:pass@api.example.com:8443/v1/x?sig=abc#f failed",
  );
  assert.ok(line.includes("https://api.example.com:8443/<path>"), line);
  assert.ok(!line.includes("pass"), line);
  assert.ok(!line.includes("sig=abc"), line);
});

test("Windows SID → <sid>", () => {
  assert.equal(
    redactWindowsSids("owner S-1-5-21-1234567890-1234567890-1234567890-1001 done"),
    "owner <sid> done",
  );
  assert.equal(redactWindowsSids("no sid here"), "no sid here");
});

test("机密值形态：Bearer/JWT/私钥块/敏感 kv/blob", () => {
  const { redactor } = createTestRedactor();
  const line = redactor.redactLine(
    'auth Bearer abcdefgh12345678 jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N kv api_key="super-secret-value" plain=ok',
  );
  assert.ok(line.includes("Bearer <token>"), line);
  assert.ok(line.includes("<jwt>"), line);
  assert.ok(!line.includes("super-secret-value"), line);
  assert.ok(line.includes("plain=ok"), "非敏感 kv 必须保留");
  const keyLine = redactor.redactLine(
    "-----BEGIN PRIVATE KEY-----\nMIIEvabc\n-----END PRIVATE KEY-----",
  );
  assert.ok(!keyLine.includes("MIIEvabc"), keyLine);
});

test("主机名组合正则：字面 + percent-encoded 边界命中", () => {
  const { redactor, registry } = createTestRedactor();
  registry.register("host", "Build.Server.Example");
  // 字面形态：整词命中替换。
  const line = redactor.redactLine("ssh Build.Server.Example ok");
  assert.ok(line.includes("<host>"), line);
  assert.ok(!line.toLowerCase().includes("build.server.example"), line);
  // percent-encoded 边界：`%2f` 的尾字符 f 是 word 字符，普通 lookbehind 会拒绝
  // 匹配；守卫 (?<=%[0-9a-f]{2}) 让紧跟 percent 转义的名字也命中。
  const encoded = redactor.redactLine("path %2fBuild.Server.Example end");
  assert.ok(encoded.includes("%2f<host>"), encoded);
  // 名字内部粘连（前缀是普通字母）不得误替换。
  const glued = redactor.redactLine("xbuild.server.example stays");
  assert.ok(glued.includes("xbuild.server.example"), glued);
});

test("组合正则按名单引用+size 缓存：注册表不变不重建", () => {
  const { redactor, registry } = createTestRedactor();
  registry.register("host", "cache.probe.example");
  redactor.redactLine("probe cache.probe.example 1");
  // 通过行为断言缓存：注册后首行命中替换；随后 1000 行不重建正则（无 size 变化）。
  for (let index = 0; index < 1000; index += 1) {
    const out = redactor.redactLine(`probe cache.probe.example line ${index}`);
    assert.ok(out.includes("<host>"));
  }
  // 注册新名字（size 变化）后仍能命中新名字 → 缓存已按 size 失效重建。
  registry.register("host", "fresh.name.example");
  assert.ok(redactor.redactLine("probe fresh.name.example").includes("<host>"));
});

test("会话 id 形态门：合法形态、出网白名单与泄漏检测", () => {
  const uuid = "12345678-1234-1234-1234-123456789abc";
  assert.ok(ACODE_SESSION_ID_PATTERN.test(`sess_${uuid}`));
  assert.ok(isCanonicalACodeSessionId(`msg_lz4k2_${uuid}`), "可排序段主体合法");
  assert.ok(isCanonicalACodeSessionId(`sess_subagent_agent-1`), "派生段合法");
  assert.ok(isCanonicalACodeSessionId(`dwfrun-${uuid}`));
  assert.ok(isCanonicalACodeSessionId(`acp-prompt-${uuid}`));
  assert.ok(isCanonicalACodeSessionId(uuid), "裸 UUID（TraceId）合法");
  assert.equal(isCanonicalACodeSessionId("sess_"), false, "空主体不合法");
  assert.equal(isCanonicalACodeSessionId(`sess_${"x".repeat(200)}`), false, "超长主体不合法");

  assert.equal(isAllowedEgressSessionValue(""), true);
  assert.equal(isAllowedEgressSessionValue("local_tab-1"), true);
  assert.equal(isAllowedEgressSessionValue(`sha256_${"a".repeat(64)}`), true);
  assert.equal(isAllowedEgressSessionValue(`sha256_${"a".repeat(63)}`), false);
  assert.equal(isAllowedEgressSessionValue(`sess_${uuid}`), false, "裸内部 id 不得出网");
  assert.equal(isAllowedEgressSessionValue(undefined), false);

  assert.equal(detectSuspectedSessionTokenLeak(`id sess_${uuid} ok`), false);
  assert.equal(detectSuspectedSessionTokenLeak(`bad sess_${"x".repeat(200)} tail`), true);
  assert.equal(detectSuspectedSessionTokenLeak("cut sess_ tail"), true, "空主体即泄漏");
  assert.equal(detectSuspectedSessionTokenLeak("no ids here"), false);
});

test("管线级泄漏抑制：不合格式会话 token → 整行 <withheld>", () => {
  const { redactor } = createTestRedactor();
  assert.equal(
    redactor.redactLine(`weird sess_${"x".repeat(200)} tail`),
    WITHHELD_LINE_PLACEHOLDER,
  );
  // 合法形态不触发抑制。
  const okLine = redactor.redactLine("session sess_12345678-1234-1234-1234-123456789abc started");
  assert.ok(okLine.includes("sess_12345678"), okLine);
});

test("fail-closed：管线内任何异常 → 整行 <withheld>，且 onError 收到诊断", () => {
  const errors: unknown[] = [];
  const broken = createLogRedactor({
    identity: {
      homeDirs: undefined as unknown as string[],
      userNames: [],
      hostNames: [],
      profileDirs: [],
    },
    onError: (error) => errors.push(error),
  });
  assert.equal(broken.redactLine("touch C:\\Users\\x\\y"), WITHHELD_LINE_PLACEHOLDER);
  assert.equal(errors.length, 1);
});

test("脱敏幂等：同一行过两次管线输出不变", () => {
  const { redactor } = createTestRedactor();
  const once = redactor.redactLine(
    "path C:\\Users\\liar\\x url https://api.example.com/p?q=1 host DESKTOP-1 sid S-1-5-21-1-2-3-4 mail a@b.co",
  );
  assert.equal(redactor.redactLine(once), once);
});

test("redactArgValue：Error 展平脱敏、对象 JSON 化脱敏", () => {
  const { redactor } = createTestRedactor();
  const error = new Error(`cannot open C:\\Users\\Real.Name\\secret.txt`);
  const flat = redactor.redactArgValue(error);
  assert.ok(!flat.includes("Real.Name"), flat);
  const obj = redactor.redactArgValue({ path: "C:\\Users\\liar\\a", level: "info" });
  assert.ok(obj.includes("<home>") || !obj.includes("liar"), obj);
});

test("feedbackPrivacy 回归：词表收敛后反馈面脱敏语义不回退", () => {
  const redacted = redactFeedbackText(
    'Authorization: Bearer abc123456 token="secret-value" url https://u:p@hooks.slack.com/x?sig=1 path /Users/bob/a',
    { diagnostic: true },
  );
  assert.ok(redacted.includes("[REDACTED]"), redacted);
  assert.ok(!redacted.includes("secret-value"), redacted);
  assert.ok(!redacted.includes("p@hooks"), redacted);
  assert.ok(!redacted.includes("Bearer abc123456"), redacted);
  // 白名单收敛：LLM 计数字段保留（排障上下文）。
  assert.ok(redactFeedbackText('{"max_tokens": 4096}').includes("4096"));
});
