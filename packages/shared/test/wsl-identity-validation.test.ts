// WSL 身份字段（distro / user）同强度校验回归。
//
// 背景（docs/security/mimosa-findings-triage-2026-11.md §6.2.1 待跟进第 6 条）：distro 曾是裸
// `z.string().optional()` 而 user 一直有专用 schema，两者严格度不对称。后果在 wsl-backend 的
// 解析路径上被放大——`safeListDistros` 枚举失败时吞错返回 []，此时用户原始 distro 字符串可不经
// 「与实际枚举结果比对」直达 `-d` argv 元素。有 `--` 终止符与 argv 隔离，不构成命令注入，
// 但未受约束的值会进入 identity、日志与 distro 比对逻辑。
//
// 本测试的核心断言是**对称性**：两个字段共用 wslIdentityChars.ts 的同一约束，任何一方被单独
// 放宽都会立刻红——那正是要防止的回归形态。
import assert from "node:assert/strict";
import test from "node:test";
import { wslConnectOptionsSchema } from "../src/validation.js";
import { isValidWslDistro, wslDistroSchema } from "../src/wslDistroValidation.js";
import { WSL_IDENTITY_MAX_LENGTH } from "../src/wslIdentityChars.js";
import { isValidWslUser, WSL_USER_MAX_LENGTH, wslUserSchema } from "../src/wslUserValidation.js";

// 真实部署里出现的 distro 名形态；加固不得拒绝其中任何一个。
const VALID = [
  "Ubuntu-22.04",
  "Ubuntu_22.04",
  "docker-desktop",
  "docker-desktop-data",
  "Debian",
  "kali-linux",
  "Alpine.WSL",
  "Ubuntu22.04LTS",
  "  Debian  ", // 前后空白被 trim，与 user 字段同一处理
];

// 会被拒的形态：路径分隔符、身份分隔符、控制字符、超长、以及 trim 后为空。
const INVALID = [
  "../escape",
  "..\\escape",
  "C:\\Windows",
  "distro/../../x",
  "a:b",
  "evil\nname",
  "evil\u0000name",
  "evil\u007fname",
  "x".repeat(WSL_IDENTITY_MAX_LENGTH + 1),
  "   ",
];

test("真实 distro 名全部通过，两个字段判定一致", () => {
  for (const value of VALID) {
    assert.equal(isValidWslDistro(value), true, `distro 应接受真实名称 ${JSON.stringify(value)}`);
    assert.equal(
      isValidWslDistro(value),
      isValidWslUser(value),
      `对称性：${JSON.stringify(value)} 在 distro 与 user 上的判定必须一致`,
    );
  }
});

test("分隔符/控制字符/超长/空白一律拒绝，两个字段判定一致", () => {
  for (const value of INVALID) {
    assert.equal(isValidWslDistro(value), false, `distro 应拒绝 ${JSON.stringify(value)}`);
    assert.equal(
      isValidWslDistro(value),
      isValidWslUser(value),
      `对称性：${JSON.stringify(value)} 在 distro 与 user 上的判定必须一致`,
    );
  }
});

test("两个 schema 形态一致：空串代表未指定而非报错", () => {
  // 空串交给后端枚举/默认 distro 决定；这是 user 字段的既有语义，distro 必须同款，
  // 否则「不指定 distro」这种最常见的用法会被拒。
  assert.equal(wslDistroSchema.safeParse("").success, true);
  assert.equal(wslUserSchema.safeParse("").success, true);
  assert.equal(wslDistroSchema.safeParse("Debian").success, true);
  assert.equal(wslDistroSchema.safeParse("../escape").success, false);
  assert.equal(wslDistroSchema.safeParse("x".repeat(WSL_IDENTITY_MAX_LENGTH + 1)).success, false);
});

test("长度上限共用同一常量（不得各自漂移）", () => {
  assert.equal(WSL_USER_MAX_LENGTH, WSL_IDENTITY_MAX_LENGTH);
  assert.equal(
    wslDistroSchema.safeParse("x".repeat(WSL_IDENTITY_MAX_LENGTH)).success,
    true,
    "恰好等于上限应通过",
  );
});

test("wslConnectOptionsSchema 的 distro 与 user 同强度", () => {
  const good = wslConnectOptionsSchema.safeParse({
    kind: "wsl",
    distro: "Ubuntu-22.04",
    user: "tester",
  });
  assert.equal(good.success, true, `合法组合应通过：${JSON.stringify(good.error?.issues)}`);

  for (const distro of ["../escape", "a:b", "evil\nname"]) {
    const bad = wslConnectOptionsSchema.safeParse({ kind: "wsl", distro, user: "tester" });
    assert.equal(bad.success, false, `distro ${JSON.stringify(distro)} 必须在连接入口被拒`);
  }

  // distro 缺席仍合法（可选字段）。
  assert.equal(wslConnectOptionsSchema.safeParse({ kind: "wsl" }).success, true);
});
