import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import yauzl from "yauzl";

// 数据根目录隔离必须在 src 模块 import 之前：logger.ts 模块加载即
// mkdir + retention 清理，ACODE_DATA_BASE_DIR 让它全部落在临时目录。
const dataBaseDir = await mkdtemp(join(tmpdir(), "acode-support-data-"));
process.env.ACODE_DATA_BASE_DIR = dataBaseDir;
process.env.ACODE_ENV = "test";

const {
  collectRedactedLogSection,
  readFileTailText,
  sampleLogLines,
  truncateSectionContentKeepingTail,
} = await import("../src/main/supportBundleLogs.js");
const { exportSupportBundle, renameWithBackoff, sweepStaleSupportBundleTmpFiles } =
  await import("../src/main/supportBundle.js");
const { collectCredentialsStatus, deriveCredentialProviders } =
  await import("../src/main/supportBundleSections.js");
const { getAppConfigDir } = await import("@acode/services/node");

/**
 * 分节支持包（specs/log-privacy-redaction.md desktop R8-R14）：
 * 预算采样、尾部截断标记、tail 读取、凭据状态（只收元数据）、
 * rename 指数退避、陈旧 tmp 清扫与端到端 zip 组装。
 */

const tempDirs = [dataBaseDir];

async function makeTempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function readZipEntries(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zipfile) => {
      if (openError) {
        reject(openError);
        return;
      }
      const entries = {};
      zipfile.once("error", reject);
      zipfile.on("entry", (entry) => {
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            reject(streamError);
            return;
          }
          const chunks = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("end", () => {
            entries[entry.fileName] = Buffer.concat(chunks).toString("utf-8");
            zipfile.readEntry();
          });
        });
      });
      zipfile.on("end", () => resolve(entries));
      zipfile.readEntry();
    });
  });
}

test("sampleLogLines：优先类 150 行 + 尾部补足到 400，顺序保持", () => {
  const lines = Array.from(
    { length: 600 },
    (_unused, index) => `line-${index}${index % 5 === 0 ? " api-error" : ""}`,
  );
  const priorityPattern = /api-error/;
  const sampled = sampleLogLines(lines, { priorityPattern });
  assert.ok(sampled.length <= 400, `total=${sampled.length}`);
  const priorityCount = sampled.filter((line) => priorityPattern.test(line)).length;
  assert.ok(priorityCount <= 150, `priority=${priorityCount}`);
  // 尾部偏向：最后一行与最后一个优先行必须入选。
  assert.ok(sampled.includes("line-599"));
  assert.ok(sampled.includes("line-595 api-error"));
  const indices = sampled.map((line) => Number(/^line-(\d+)/.exec(line)[1]));
  assert.deepEqual(
    indices,
    [...indices].sort((left, right) => left - right),
  );
});

test("truncateSectionContentKeepingTail：超限保留尾部并带截断标记", () => {
  const big = Array.from(
    { length: 5000 },
    (_unused, index) => `row-${index}-${"x".repeat(50)}`,
  ).join("\n");
  const truncated = truncateSectionContentKeepingTail(big, 5000);
  assert.ok(truncated.startsWith("…（已截断，显示最后"), truncated.slice(0, 40));
  assert.ok(truncated.includes("row-4999"));
  assert.ok(!truncated.includes("row-0-x"));
  const small = "a\nb";
  assert.equal(truncateSectionContentKeepingTail(small, 5000), small);
});

test("readFileTailText：只读尾部、丢弃首个不完整行、缺失文件返回 null", async () => {
  const dir = await makeTempDir("acode-tail-");
  const file = join(dir, "big.log");
  await writeFile(
    file,
    Array.from({ length: 500 }, (_u, i) => `L${i} ${"y".repeat(20)}`).join("\n"),
  );
  const tail = await readFileTailText(file, 200);
  assert.ok(tail !== null);
  for (const line of tail.split("\n").filter(Boolean)) {
    assert.match(line, /^L\d+ y{20}$/, `半行泄漏: ${JSON.stringify(line)}`);
  }
  assert.ok(tail.includes("L499"));
  assert.equal(await readFileTailText(join(dir, "missing.log"), 100), null);
});

test("collectRedactedLogSection：warn|error 过滤 + 机密/路径/内网地址脱敏", async () => {
  const dir = await makeTempDir("acode-logsec-");
  const file = join(dir, "2026-10-15.log");
  const secret = `sk-${"A".repeat(30)}`;
  await writeFile(
    file,
    [
      "[2026-10-15 10:00:00] [info] [pid:1] [main] hello-info-line",
      `[2026-10-15 10:00:01] [warn] [pid:1] [main] call failed key=${secret} path ${join(homedir(), "private-doc.txt")}`,
      "[2026-10-15 10:00:02] [error] [pid:1] [main] dial https://user:pass@internal.srv.local:911/admin?x=1",
    ].join("\n"),
  );
  const out = await collectRedactedLogSection({
    files: [file],
    lineFilter: /\[(?:warn|error)\]/,
    priorityPattern: /\[error\]/,
    emptyNotice: "(empty)",
  });
  assert.ok(!out.includes("hello-info-line"), "info 行必须被过滤");
  assert.ok(!out.includes(secret), out);
  assert.ok(!out.includes("internal.srv.local"), out);
  assert.ok(!out.includes("pass@"), out);
  if (homedir().length >= 4) {
    assert.ok(!out.includes(homedir()), out);
  }
  const empty = await collectRedactedLogSection({
    files: [join(dir, "none.log")],
    lineFilter: /\[(?:warn|error)\]/,
    emptyNotice: "(empty)",
  });
  assert.equal(empty, "(empty)");
});

test("凭据状态：只收 {status, providers, count}，绝不带值", async () => {
  assert.deepEqual(
    deriveCredentialProviders(["oauth:glm:access_token", "oauth:zai:refresh_token", "login:acode"]),
    ["glm", "login", "zai"],
  );
  const configDir = getAppConfigDir();
  await mkdir(configDir, { recursive: true });
  const credentialsFile = join(configDir, "credentials.json");
  await writeFile(
    credentialsFile,
    JSON.stringify({ "oauth:glm:access_token": "ENCRYPTED-VALUE", other: "ANOTHER-SECRET" }),
  );
  const ok = await collectCredentialsStatus();
  assert.deepEqual(ok, { status: "ok", providers: ["glm", "other"], count: 2 });
  assert.ok(!JSON.stringify(ok).includes("ENCRYPTED-VALUE"));
  await writeFile(credentialsFile, "{corrupt");
  assert.equal((await collectCredentialsStatus()).status, "corrupt");
  await rm(credentialsFile);
  assert.equal((await collectCredentialsStatus()).status, "not-configured");
});

test("renameWithBackoff：200ms×2 指数退避，成功即停", async () => {
  let now = 0;
  const sleeps = [];
  let failures = 2;
  await renameWithBackoff("from", "to", {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    renameImpl: async () => {
      if (failures > 0) {
        failures -= 1;
        const error = new Error("busy");
        error.code = "EBUSY";
        throw error;
      }
    },
  });
  assert.deepEqual(sleeps, [200, 400]);
});

test("renameWithBackoff：预算封顶 5s；非可重试错误立即抛出", async () => {
  let now = 0;
  await assert.rejects(
    renameWithBackoff("from", "to", {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      renameImpl: async () => {
        const error = new Error("perm");
        error.code = "EPERM";
        throw error;
      },
    }),
  );
  assert.ok(now <= 5000, `总退避必须封顶 5s，实际 ${now}`);
  assert.ok(now >= 4800, `应耗尽预算，实际 ${now}`);

  let attempts = 0;
  await assert.rejects(
    renameWithBackoff("from", "to", {
      renameImpl: async () => {
        attempts += 1;
        const error = new Error("bad");
        error.code = "EINVAL";
        throw error;
      },
    }),
  );
  assert.equal(attempts, 1);
});

test("sweepStaleSupportBundleTmpFiles：只清扫 10 分钟前的 tmp", async () => {
  const dir = await makeTempDir("acode-sweep-");
  const stalePath = join(dir, "acode-support-old.zip.tmp");
  const freshPath = join(dir, "acode-support-new.zip.tmp");
  const otherPath = join(dir, "acode-logs-x.zip");
  await writeFile(stalePath, "stale");
  await writeFile(freshPath, "fresh");
  await writeFile(otherPath, "keep");
  const staleTime = new Date(Date.now() - 11 * 60 * 1000);
  await utimes(stalePath, staleTime, staleTime);
  const removed = await sweepStaleSupportBundleTmpFiles(dir);
  assert.equal(removed, 1);
  const remaining = (await readdir(dir)).sort();
  assert.deepEqual(remaining, ["acode-logs-x.zip", "acode-support-new.zip.tmp"]);
});

test("exportSupportBundle：端到端组装 zip、失败节隔离、tmp 清扫", async () => {
  const outRoot = await makeTempDir("acode-support-out-");
  const stageRoot = await makeTempDir("acode-support-stage-");
  const context = {
    logsDir: join(outRoot, "none"),
    cliLogDir: join(outRoot, "none"),
    cuaHelperRunDir: join(outRoot, "none"),
    aboutContent: "ACode test-build",
    credentials: { status: "ok", providers: ["glm"], count: 1 },
  };
  const registry = [
    {
      id: "ok-section",
      group: "metadata",
      label: "OK 节——测试承诺文案",
      defaultChecked: true,
      collect: () => "hello support",
    },
    {
      id: "boom",
      group: "logs",
      label: "会失败的节",
      defaultChecked: true,
      collect: () => {
        throw new Error(`collector exploded at ${join(homedir(), "secret-place")}`);
      },
    },
    {
      id: "opt-out",
      group: "metadata",
      label: "未勾选节",
      defaultChecked: false,
      collect: () => "never",
    },
    {
      id: "not-applicable",
      group: "metadata",
      label: "不适用节",
      defaultChecked: true,
      appliesIn: () => false,
      collect: () => "never",
    },
  ];
  const steps = [];
  const result = await exportSupportBundle({
    context,
    registry,
    outputRootDir: outRoot,
    stageRootDir: stageRoot,
    showItemInFolder: () => {},
    onStep: (label) => steps.push(label),
    now: () => new Date(2026, 9, 15, 12, 0, 0),
  });
  assert.equal(result.success, true, result.error);
  assert.ok(result.path.endsWith("acode-support-20261015-120000.zip"), result.path);
  const sectionIds = result.sections.map((section) => section.id).sort();
  assert.deepEqual(sectionIds, ["boom", "ok-section"]);
  assert.equal(result.sections.find((section) => section.id === "boom").status, "failed");
  assert.deepEqual(steps, ["OK 节——测试承诺文案", "会失败的节"]);

  const entries = await readZipEntries(result.path);
  assert.ok(entries["sections/metadata--ok-section.txt"].includes("hello support"));
  const boomContent = entries["sections/logs--boom.txt"];
  assert.ok(boomContent.startsWith("<section failed:"), boomContent);
  // 失败摘要本身必须脱敏（错误消息里的家目录不得带出）。
  if (homedir().length >= 4) {
    assert.ok(!boomContent.includes(homedir()), boomContent);
  }
  const manifest = JSON.parse(entries["manifest.json"]);
  assert.equal(manifest.sectionCount, 2);
  assert.equal(manifest.sections[0].label, "OK 节——测试承诺文案");

  const leftovers = (await readdir(outRoot)).filter((name) => name.endsWith(".zip.tmp"));
  assert.deepEqual(leftovers, [], "tmp 必须已 rename/清扫");
});

test("exportSupportBundle：显式勾选覆盖 defaultChecked，仍受 appliesIn 约束", async () => {
  const outRoot = await makeTempDir("acode-support-out2-");
  const stageRoot = await makeTempDir("acode-support-stage2-");
  const context = {
    logsDir: outRoot,
    cliLogDir: outRoot,
    cuaHelperRunDir: outRoot,
    aboutContent: "about",
    credentials: { status: "not-configured", providers: [], count: 0 },
  };
  const registry = [
    { id: "a", group: "metadata", label: "A", defaultChecked: false, collect: () => "a-content" },
    { id: "b", group: "metadata", label: "B", defaultChecked: true, collect: () => "b-content" },
    {
      id: "c",
      group: "metadata",
      label: "C",
      defaultChecked: true,
      appliesIn: () => false,
      collect: () => "c",
    },
  ];
  const result = await exportSupportBundle({
    context,
    registry,
    sections: ["a", "c"],
    outputRootDir: outRoot,
    stageRootDir: stageRoot,
    showItemInFolder: () => {},
  });
  assert.equal(result.success, true, result.error);
  assert.deepEqual(
    result.sections.map((section) => section.id),
    ["a"],
    "appliesIn=false 的节不可被勾选",
  );
});
