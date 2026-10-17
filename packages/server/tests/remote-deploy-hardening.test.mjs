// 部署补强测试（spec: packages/server/specs/remote-deploy-hardening.md 验收场景 1-4）。
// 纯本地：fake backend 回放 df 输出，不依赖真实 SSH 服务器。
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  estimateRemoteDeployAssetBytes,
  parseDfAvailableBytes,
  preflightRemoteDeployDiskSpace,
  RemoteDeployDiskSpaceError,
  REMOTE_DEPLOY_DISK_HEADROOM_MULTIPLIER,
} from "../src/remote/remoteDeployDiskSpace.ts";
import {
  assessRemoteServerCompat,
  compareDottedVersions,
  parseRemoteAssetManifestCompatWindow,
  RemoteServerCompatError,
} from "../src/remote/remoteVersionCompat.ts";
import {
  createRemoteAssetManifestGuard,
  createUnconfiguredManifestSignatureVerifier,
  RemoteAssetManifestSignatureError,
} from "../src/remote/remoteAssetManifestSignature.ts";

const GNU_DF_OUTPUT = [
  "Filesystem     1K-blocks    Used Available Use% Mounted on",
  "/dev/sda1       51200000 1000000  50200000   2% /",
  "",
].join("\n");

function createFakeBackend(scriptedResponses) {
  const executed = [];
  return {
    executed,
    async exec(command) {
      executed.push(command);
      const response =
        typeof scriptedResponses === "function"
          ? scriptedResponses(command, executed.length)
          : scriptedResponses;
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      let closeListener;
      setTimeout(() => {
        if (response.stdout) {
          stdout.emit("data", Buffer.from(response.stdout));
        }
        closeListener?.(response.code);
      }, 0);
      return {
        stdin: new EventEmitter(),
        stdout,
        stderr,
        onClose: (listener) => {
          closeListener = listener;
          return { dispose() {} };
        },
      };
    },
  };
}

const silentLoggers = { log: () => undefined, logWarn: () => undefined };

function collectingLoggers() {
  const warnings = [];
  const logs = [];
  return {
    warnings,
    logs,
    loggers: {
      log: (...args) => logs.push(args.join(" ")),
      logWarn: (...args) => warnings.push(args.join(" ")),
    },
  };
}

test("parseDfAvailableBytes handles GNU/BusyBox, wrapped device names and missing % column", () => {
  assert.equal(parseDfAvailableBytes(GNU_DF_OUTPUT), 50_200_000 * 1024);
  // Filesystem 名过长换行：数据行以设备名残片开头
  const wrapped = [
    "Filesystem",
    "verylongdevicename",
    "         1K-blocks Used Available Use% Mounted on",
    "verylongdevicename 1000 500 400 56% /mnt",
  ].join("\n");
  assert.equal(parseDfAvailableBytes(wrapped), 400 * 1024);
  // 无容量列的老形态：取第 3 个纯数字字段
  const noPercent = ["Filesystem blocks used avail mount", "fs 1000 500 400 /mnt"].join("\n");
  assert.equal(parseDfAvailableBytes(noPercent), 400 * 1024);
  // 垃圾输出
  assert.equal(parseDfAvailableBytes("df: command not found"), null);
  assert.equal(parseDfAvailableBytes(""), null);
  assert.equal(parseDfAvailableBytes("only one line"), null);
});

test("disk preflight rejects when headroom is below 7x the estimated asset size", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-deploy-disk-"));
  try {
    // 资产估算 1MB → 需求 7MB；df 报 6MB 可用（6144 KB）
    const releaseDir = join(root, "release");
    await mkdir(join(releaseDir, "server"), { recursive: true });
    await writeFile(join(releaseDir, "server", "acode-server.cjs"), "x".repeat(1024 * 1024));

    const insufficient = createFakeBackend({
      code: 0,
      stdout: ["Filesystem 1K-blocks Used Available Use% Mounted on", "fs 100000 90000 6144 94% /home"].join("\n"),
    });
    const { warnings } = collectingLoggers();
    await assert.rejects(
      preflightRemoteDeployDiskSpace(insufficient, {
        requiredRelativePaths: ["server/acode-server.cjs"],
        resolveReleaseDir: async () => releaseDir,
        loggers: silentLoggers,
      }),
      (error) => {
        assert.ok(error instanceof RemoteDeployDiskSpaceError);
        assert.equal(error.code, "remote-disk-space-insufficient");
        assert.match(error.message, /远端磁盘余量不足/u);
        assert.match(error.message, /7/u);
        return true;
      },
    );
    assert.equal(REMOTE_DEPLOY_DISK_HEADROOM_MULTIPLIER, 7);
    // 拒绝路径只执行了 df 探测，没有任何远端写入
    assert.ok(insufficient.executed.length > 0);
    for (const command of insufficient.executed) {
      assert.match(command, /^df /u);
    }
    assert.equal(warnings.length, 0);

    // 余量充足 → 放行
    const sufficient = createFakeBackend({
      code: 0,
      stdout: ["Filesystem 1K-blocks Used Available Use% Mounted on", "fs 1000000 1000 900000 1% /home"].join("\n"),
    });
    await preflightRemoteDeployDiskSpace(sufficient, {
      requiredRelativePaths: ["server/acode-server.cjs"],
      resolveReleaseDir: async () => releaseDir,
      loggers: silentLoggers,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disk preflight degrades to warn-and-continue on probe failure or unknown estimate", async () => {
  // 探测失败（df 不存在）→ warn 后继续
  const noDf = createFakeBackend({ code: 127, stdout: "" });
  const { warnings: probeWarnings, loggers } = collectingLoggers();
  await preflightRemoteDeployDiskSpace(noDf, {
    requiredRelativePaths: ["server/acode-server.cjs"],
    resolveReleaseDir: async () => null,
    loggers,
  });
  assert.ok(probeWarnings.some((line) => line.includes("df probe unavailable")));
  // 依序探测 REMOTE_BASE → $HOME → /
  assert.equal(noDf.executed.length, 3);

  // 探测成功但无法估算资产 → warn 跳过比较，不臆造数字拒绝
  const okProbe = createFakeBackend({
    code: 0,
    stdout: GNU_DF_OUTPUT,
  });
  const { warnings: estimateWarnings, loggers: loggers2 } = collectingLoggers();
  await preflightRemoteDeployDiskSpace(okProbe, {
    requiredRelativePaths: ["server/acode-server.cjs"],
    resolveReleaseDir: async () => null,
    manifestComponents: null,
    loggers: loggers2,
  });
  assert.ok(estimateWarnings.some((line) => line.includes("not estimable")));
});

test("asset estimate prefers release-dir stat and falls back to manifest sizeBytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-deploy-estimate-"));
  try {
    await mkdir(join(root, "node", "linux-x64"), { recursive: true });
    await writeFile(join(root, "node", "linux-x64", "node"), "x".repeat(2048));
    const fromFiles = await estimateRemoteDeployAssetBytes({
      releaseDir: root,
      requiredRelativePaths: ["node/linux-x64/node", "missing/file"],
      manifestComponents: [{ id: "node-runtime", sizeBytes: 999 }],
    });
    assert.equal(fromFiles, 2048, "missing files are skipped; existing files are summed");
    const fromManifest = await estimateRemoteDeployAssetBytes({
      releaseDir: null,
      requiredRelativePaths: ["node/linux-x64/node"],
      manifestComponents: [
        { id: "node-runtime", sizeBytes: 999 },
        { id: "server-bundle", sizeBytes: "not-a-number" },
        { id: "glm", sizeBytes: 1 },
      ],
    });
    assert.equal(fromManifest, 1000);
    const unknown = await estimateRemoteDeployAssetBytes({
      releaseDir: null,
      requiredRelativePaths: [],
      manifestComponents: null,
    });
    assert.equal(unknown, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compareDottedVersions orders cores numerically and prerelease below release", () => {
  assert.equal(compareDottedVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareDottedVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareDottedVersions("0.9.0", "1.0.0"), -1);
  assert.equal(compareDottedVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareDottedVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareDottedVersions("1.0.0-rc.1", "1.0.0-rc.2"), -1);
  assert.equal(compareDottedVersions("2.1", "2.1.0"), 0);
});

test("compat window verdicts: hard window rejects, testedVersions only warns, undeclared passes", () => {
  const currentVersion = "1.5.0";
  assert.deepEqual(assessRemoteServerCompat({ currentVersion }), { status: "undeclared" });
  assert.deepEqual(
    assessRemoteServerCompat({
      currentVersion,
      compatWindow: { minDesktopVersion: "1.0.0", maxDesktopVersion: "2.0.0" },
    }),
    { status: "compatible" },
  );
  const below = assessRemoteServerCompat({
    currentVersion: "0.9.0",
    compatWindow: { minDesktopVersion: "1.0.0" },
  });
  assert.equal(below.status, "out_of_window");
  assert.match(below.message, /低于窗口下限/u);
  const above = assessRemoteServerCompat({
    currentVersion: "2.1.0",
    compatWindow: { maxDesktopVersion: "2.0.0" },
  });
  assert.equal(above.status, "out_of_window");
  assert.match(above.message, /超出窗口上限/u);
  const untested = assessRemoteServerCompat({
    currentVersion,
    compatWindow: { testedVersions: ["1.4.0", "1.6.0"] },
  });
  assert.equal(untested.status, "untested_warning");
  assert.match(untested.message, /未测试不等于不兼容/u);
});

test("parseRemoteAssetManifestCompatWindow is defensive about malformed shapes", () => {
  assert.equal(parseRemoteAssetManifestCompatWindow(null), undefined);
  assert.equal(parseRemoteAssetManifestCompatWindow({}), undefined);
  assert.equal(parseRemoteAssetManifestCompatWindow({ compat: "nope" }), undefined);
  assert.equal(
    parseRemoteAssetManifestCompatWindow({ compat: { testedVersions: [1, 2] } }),
    undefined,
  );
  assert.deepEqual(
    parseRemoteAssetManifestCompatWindow({
      compat: {
        schemaVersion: 1,
        testedVersions: ["1.0.0"],
        minDesktopVersion: "1.0.0",
        maxDesktopVersion: 42,
      },
    }),
    { schemaVersion: 1, testedVersions: ["1.0.0"], minDesktopVersion: "1.0.0" },
  );
});

test("manifest guard: invalid signature and compat violations reject before any remote write", async () => {
  // 注入 verifier 返回 invalid → 拒绝
  const invalidGuard = createRemoteAssetManifestGuard({
    currentVersion: "1.5.0",
    signatureVerifier: {
      async verify() {
        return { status: "invalid", detail: "signature mismatch" };
      },
    },
    loggers: silentLoggers,
  });
  await assert.rejects(
    invalidGuard.inspect({ components: [] }, { source: "cdn" }),
    (error) => {
      assert.ok(error instanceof RemoteAssetManifestSignatureError);
      assert.equal(error.code, "remote-asset-manifest-signature-invalid");
      assert.match(error.message, /签名无效/u);
      return true;
    },
  );

  // verifier 抛错 → fail-closed 按 invalid 处理
  const throwingGuard = createRemoteAssetManifestGuard({
    currentVersion: "1.5.0",
    signatureVerifier: {
      async verify() {
        throw new Error("keyring unavailable");
      },
    },
    loggers: silentLoggers,
  });
  await assert.rejects(
    throwingGuard.inspect({}, { source: "local-cache" }),
    RemoteAssetManifestSignatureError,
  );

  // 兼容窗外 → RemoteServerCompatError
  const compatGuard = createRemoteAssetManifestGuard({
    currentVersion: "0.9.0",
    loggers: silentLoggers,
  });
  await assert.rejects(
    compatGuard.inspect(
      { compat: { minDesktopVersion: "1.0.0" }, components: [] },
      { source: "cdn" },
    ),
    (error) => {
      assert.ok(error instanceof RemoteServerCompatError);
      assert.equal(error.code, "remote-server-compat-out-of-window");
      return true;
    },
  );
});

test("manifest guard: not-configured passes with a single log line and memoizes per manifest", async () => {
  let verifyCalls = 0;
  const { logs, warnings, loggers } = collectingLoggers();
  const guard = createRemoteAssetManifestGuard({
    currentVersion: "1.5.0",
    signatureVerifier: {
      async verify() {
        verifyCalls += 1;
        return createUnconfiguredManifestSignatureVerifier().verify({});
      },
    },
    loggers,
  });
  const manifest = { components: [] };
  await guard.inspect(manifest, { source: "cdn" });
  await guard.inspect(manifest, { source: "cdn" });
  assert.equal(verifyCalls, 1, "same manifest object is judged once");
  assert.equal(
    logs.filter((line) => line.includes("not configured")).length,
    1,
    "not-configured is logged once",
  );

  // untested warning 路径放行
  await guard.inspect(
    { compat: { testedVersions: ["9.9.9"] }, components: [] },
    { source: "local-cache" },
  );
  assert.ok(warnings.some((line) => line.includes("testedVersions")));

  // 非对象 manifest 防御性放行（由既有解析层报错）
  await guard.inspect(null, { source: "cdn" });
});
