// workspace-hook-review-pins 接线守护（specs/plugin-hook-middleware.md 三 / 接线 W3）。
// 授予面 pinGranted（三态分类 + 合并写）、dispatch 前复核面 detectDrift（等价判定，
// unpinnable 永不等价 = fail-closed 漂移）、撤销后 forgetPins（陈旧 pin 清理防重复检出）。
// 文件面用真实临时目录驱动（与 workspace-hook-pins.test.mjs 同款约定）；snapshot 用
// 普通对象（port 只读字段，不做 schema 校验——校验在 discovery/contracts 层）。
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const { createWorkspaceHookReviewPinsPort } = await import(
  "../packages/bootstrap/src/app/workspace-hook-review-pins.ts"
);

let root;
let projectDir;
let guardPath;

const DIGEST_SCRIPT = "a".repeat(64);
const DIGEST_INLINE = "b".repeat(64);
const DIGEST_BARE = "c".repeat(64);

function hookEntry(overrides) {
  return {
    command: "node .acode/hooks/guard.mjs",
    configuredEnabled: true,
    declarationDigestAlgorithm: "sha256",
    declarationEnabled: true,
    editable: true,
    event: "PreToolUse",
    hookDeclarationDigest: DIGEST_SCRIPT,
    hookIndex: 0,
    matcher: null,
    matcherIndex: 0,
    resolvedMaxOutputBytes: 32_768,
    resolvedTimeoutMs: 60_000,
    reviewItemId: "item-script",
    runtimeHooksEnabled: true,
    sourceFileIndex: 0,
    sourceRelativePath: ".acode/config.json",
    sourceRootEnabled: true,
    type: "command",
    ...overrides,
  };
}

function snapshot(hooks) {
  return {
    bundleDigest: "d".repeat(64),
    digestAlgorithm: "sha256",
    discoveredAt: new Date().toISOString(),
    hooks,
    schemaVersion: 1,
    sourceFiles: [
      {
        baseDir: projectDir,
        canonicalPath: join(projectDir, ".acode", "config.json"),
        configFileKind: ".acode/config.json",
        discoveryOrder: 0,
        editable: true,
        explicitProjectConfig: false,
        hooksRoot: {},
      },
    ],
    workspaceIdentity: "/repo/pins-wiring",
  };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "acode-hook-pins-wiring-"));
  projectDir = join(root, "project");
  await mkdir(join(projectDir, ".acode", "hooks"), { recursive: true });
  guardPath = join(projectDir, ".acode", "hooks", "guard.mjs");
  await writeFile(guardPath, "console.log('guard v1');\n");
});

after(async () => {
  if (root) await rm(root, { force: true, recursive: true });
});

function makePort() {
  return createWorkspaceHookReviewPinsPort({
    homeDir: root,
    userConfigPath: join(root, "missing-config.json"),
  });
}

test("授予时钉扎：script/inline/bare 三态各归其位，合并写保留既有 pin", async () => {
  const port = makePort();
  const entries = [
    hookEntry({}),
    hookEntry({
      command: "node .acode/hooks/guard.mjs | tee log.txt",
      hookDeclarationDigest: DIGEST_INLINE,
      reviewItemId: "item-inline",
    }),
  ];
  const snap = snapshot(entries);

  await port.pinGranted({ reviewItemIds: ["item-script"], snapshot: snap });
  await port.pinGranted({ reviewItemIds: ["item-inline"], snapshot: snap });

  const pinsFile = await readPinsDocument();
  assert.equal(pinsFile.project, "/repo/pins-wiring");
  const scriptPin = pinsFile.pins[DIGEST_SCRIPT];
  assert.equal(scriptPin.kind, "script");
  assert.match(scriptPin.sha256, /^[0-9a-f]{64}$/u);
  // 存储 path 是 realpath 规范值（分类层约定）。
  assert.ok(scriptPin.path.endsWith(join(".acode", "hooks", "guard.mjs")));
  assert.deepEqual(pinsFile.pins[DIGEST_INLINE], { kind: "inline" }, "合并写丢了后授予的 pin 或先授予的 pin");

  // 授予时无漂移。
  assert.deepEqual(await port.detectDrift(snap), []);
});

test("dispatch 前复核 fail-closed：脚本内容漂移 → 检出 digest；unpinnable 永不等价 → 恒检出", async () => {
  const port = makePort();
  const bare = hookEntry({
    command: "npx some-checker",
    hookDeclarationDigest: DIGEST_BARE,
    reviewItemId: "item-bare",
  });
  const snap = snapshot([hookEntry({}), bare]);
  await port.pinGranted({ reviewItemIds: ["item-bare"], snapshot: snap });
  const bareDocument = await readPinsDocument();
  assert.deepEqual(bareDocument.pins[DIGEST_BARE], { kind: "unpinnable" }, "裸 PATH 程序名必须分类为 unpinnable");
  // unpinnable 与任何 pin（含 unpinnable）都不等价——未知态永远触发重新核验（三态核心）。
  assert.deepEqual(await port.detectDrift(snap), [DIGEST_BARE]);

  // 脚本内容漂移：授予时钉的是 v1 哈希，改盘后复核必须检出。
  await writeFile(guardPath, "console.log('guard v2 — drifted');\n");
  const drifted = await port.detectDrift(snap);
  assert.ok(drifted.includes(DIGEST_SCRIPT), "脚本内容漂移没有被复核检出");
  assert.ok(drifted.includes(DIGEST_BARE));
});

test("forgetPins：撤销后清理陈旧 pin，复核不再重复检出；无 pin 声明按无从比对跳过", async () => {
  const port = makePort();
  const snap = snapshot([
    hookEntry({}),
    hookEntry({
      command: "npx some-checker",
      hookDeclarationDigest: DIGEST_BARE,
      reviewItemId: "item-bare",
    }),
  ]);
  await port.forgetPins([DIGEST_SCRIPT, DIGEST_BARE], snap);
  assert.deepEqual(await port.detectDrift(snap), [], "陈旧 pin 未清理：每次激活都会重复检出同一漂移");

  // 波前存量授予（从未钉扎）→ 复核跳过（trust 主层仍是权威，不误撤）。
  const unpinned = snapshot([hookEntry({ hookDeclarationDigest: "e".repeat(64) })]);
  assert.deepEqual(await port.detectDrift(unpinned), []);
});

test("接线文字在案：授予面/复核面/包装面三处调用点与单源注释", async () => {
  const controller = await readFile(
    new URL("../packages/bootstrap/src/app/workspace-hook-review-controller.ts", import.meta.url),
    "utf8",
  );
  assert.match(controller, /this\.pins\.pinGranted\(\{ reviewItemIds, snapshot \}\)/u, "授予时钉扎接线缺失");
  assert.match(controller, /recheckPinsBeforeDispatch/u, "dispatch 前复核入口缺失");
  assert.match(controller, /applyWorkspaceHookRevoke/u, "漂移回待信任必须复用既有 revoke 面");

  const trust = await readFile(
    new URL("../packages/bootstrap/src/app/workspace-hook-trust.ts", import.meta.url),
    "utf8",
  );
  assert.match(trust, /recheckPinsBeforeDispatch/u, "activate 包装没有接复核");
  assert.match(trust, /createWorkspaceHookReviewPinsPort/u, "pins port 装配缺失");
  assert.match(trust, /admission: admissionPort/u, "对外必须暴露包装后的 admission（复核在 activate 边界生效）");
});

async function readPinsDocument() {
  const { workspaceHookPinsDirPath, workspaceHookPinsFileName } = await import(
    "../packages/core/src/hooks/workspace-hook-pins.ts"
  );
  const pinsDir = workspaceHookPinsDirPath(join(root, ".acode"));
  const raw = await readFile(join(pinsDir, workspaceHookPinsFileName("/repo/pins-wiring")), "utf8");
  return JSON.parse(raw);
}
