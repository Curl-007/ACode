import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createVisualizationVendorFileServer } from "../src/main/visualizationVendorProtocol.js";

/**
 * viz-vendor 协议身份层守护（价值提取第二轮 T1-m1 消费点接入）：
 * sha256 运行态闸保留，默认读取面叠加文件遏制层——符号链接替换、硬链接别名
 * （nlink>1）一律 fail-closed 404（load 返回 null），即使 sha256 完全相符。
 * 规格：packages/services/specs/file-containment-trust-tiers.md R6.4。
 */

const FILE_NAME = "npm_probe@1.0.0_probe.min.js";

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createVendorDir({ fileName = FILE_NAME, content = "console.log(1);", sha256 }) {
  const vendorDir = await mkdtemp(join(tmpdir(), "acode-viz-vendor-"));
  const manifest = {
    libraries: [{ fileName, sha256: sha256 ?? sha256Hex(Buffer.from(content)) }],
    version: 1,
  };
  await writeFile(join(vendorDir, "manifest.json"), JSON.stringify(manifest), "utf8");
  await writeFile(join(vendorDir, fileName), content, "utf8");
  return vendorDir;
}

function createServer(vendorDir) {
  // 不注入 readFileBytes：走默认的遏制层读取面（本测试的对象）。
  return createVisualizationVendorFileServer({ resolveVendorDir: () => vendorDir });
}

async function canCreateSymlink(dir) {
  const target = join(dir, "sym-target.txt");
  const linkPath = join(dir, "sym-link.txt");
  await writeFile(target, "x", "utf8");
  try {
    await symlink(target, linkPath);
    return true;
  } catch {
    // Windows 无开发者模式/权限时 EPERM：相关用例按平台能力跳过。
    return false;
  }
}

test("基线：manifest 相符时经遏制层读取返回字节；缺失/篡改返回 null", async () => {
  const vendorDir = await createVendorDir({});
  try {
    const server = createServer(vendorDir);
    const bytes = await server.load(FILE_NAME);
    assert.equal(Buffer.from(bytes).toString("utf8"), "console.log(1);");

    assert.equal(await server.load("npm_missing@1.0.0_x.min.js"), null, "manifest 未登记 → 404");

    // 内容被替换（sha256 不符）→ 既有完整性闸拒绝。
    const tamperedDir = await createVendorDir({ content: "original" });
    await writeFile(join(tamperedDir, FILE_NAME), "tampered", "utf8");
    assert.equal(await createServer(tamperedDir).load(FILE_NAME), null, "sha256 不符 → 404");
    await rm(tamperedDir, { force: true, recursive: true });
  } finally {
    await rm(vendorDir, { force: true, recursive: true });
  }
});

test("身份层：资产被替换为符号链接（sha256 相符）仍拒绝", async () => {
  const vendorDir = await createVendorDir({});
  try {
    if (!(await canCreateSymlink(vendorDir))) return;
    const outside = join(vendorDir, "outside-copy.js");
    await writeFile(outside, "console.log(1);", "utf8");
    await rm(join(vendorDir, FILE_NAME));
    await symlink(outside, join(vendorDir, FILE_NAME));

    // 符号链接目标内容与 manifest sha256 完全一致——纯内容闸会放行，
    // 身份层必须拒绝（reparse point 改道）。
    assert.equal(await createServer(vendorDir).load(FILE_NAME), null);
  } finally {
    await rm(vendorDir, { force: true, recursive: true });
  }
});

test("身份层：nlink>1 硬链接别名拒绝", async () => {
  const vendorDir = await createVendorDir({});
  try {
    const aliasPath = join(tmpdir(), `acode-viz-vendor-alias-${Date.now()}.js`);
    try {
      await link(join(vendorDir, FILE_NAME), aliasPath);
    } catch {
      return; // 文件系统不支持硬链接：跳过。
    }
    try {
      assert.equal(await createServer(vendorDir).load(FILE_NAME), null);
    } finally {
      await rm(aliasPath, { force: true });
    }
  } finally {
    await rm(vendorDir, { force: true, recursive: true });
  }
});

test("身份层：manifest.json 被替换为符号链接时整体 fail-closed", async () => {
  const vendorDir = await createVendorDir({});
  try {
    if (!(await canCreateSymlink(vendorDir))) return;
    const realManifest = join(vendorDir, "manifest-real.json");
    await rm(join(vendorDir, "manifest.json"));
    await writeFile(realManifest, JSON.stringify({ libraries: [], version: 1 }), "utf8");
    await symlink(realManifest, join(vendorDir, "manifest.json"));

    // manifest 读取经同一遏制层：符号链接 manifest 直接判不可信 → 404。
    assert.equal(await createServer(vendorDir).load(FILE_NAME), null);
  } finally {
    await rm(vendorDir, { force: true, recursive: true });
  }
});

test("身份层：vendorDir 缺失/非目录时 fail-closed 返回 null（不抛错）", async () => {
  const missingDir = join(tmpdir(), `acode-viz-vendor-missing-${Date.now()}`);
  assert.equal(await createServer(missingDir).load(FILE_NAME), null);

  const fileAsDir = join(tmpdir(), `acode-viz-vendor-file-${Date.now()}`);
  await mkdir(join(fileAsDir, ".."), { recursive: true });
  await writeFile(fileAsDir, "not-a-dir", "utf8");
  try {
    assert.equal(await createServer(fileAsDir).load(FILE_NAME), null);
  } finally {
    await rm(fileAsDir, { force: true });
  }
});
