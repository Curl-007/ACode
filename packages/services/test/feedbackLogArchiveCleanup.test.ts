import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { cleanupLogArchive, prepareCompactLogArchive } from "../src/feedback/compactLogArchive.js";
import { getAppConfigDir, getFeedbackLogArchiveDir, setDataBaseDir } from "../src/paths.js";

/**
 * H3 修复守护：cleanupLogArchive 的清理目标必须位于 getFeedbackLogArchiveDir() 受控根内。
 * 根因：path 是 RPC 裸 string（cleanupPreparedLogArchive 原样透传），原实现直接
 * rm(join(path,".."),{recursive:true,force:true}) 且吞异常——传 `<任意目录>\x` 即递归
 * 删除任意目录整树。spec: packages/services/specs/service-fs-path-confinement.md R1。
 */

let dataBaseDir: string;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

before(async () => {
  dataBaseDir = await mkdtemp(join(tmpdir(), "acode-feedback-cleanup-"));
  setDataBaseDir(dataBaseDir);
});

after(() => {
  setDataBaseDir(null);
});

test("合法清理：受控根内的归档目录被删除，根本身保留", async () => {
  const root = getFeedbackLogArchiveDir();
  const archiveDir = join(root, "archive-legal");
  await mkdir(archiveDir, { recursive: true });
  const archivePath = join(archiveDir, "acode-diagnostic-logs.zip");
  await writeFile(archivePath, "zip-bytes", "utf-8");

  await cleanupLogArchive(archivePath);

  assert.equal(await exists(archiveDir), false, "归档临时目录应被清理");
  assert.equal(await exists(root), true, "受控根目录自身不可被删除");
});

test("越界拒绝：受控根之外的任意目录不被递归删除", async () => {
  const victimDir = await mkdtemp(join(tmpdir(), "acode-feedback-victim-"));
  const victimFile = join(victimDir, "important.txt");
  await writeFile(victimFile, "victim", "utf-8");

  await assert.rejects(
    () => cleanupLogArchive(join(victimDir, "x.zip")),
    /outside the managed archive directory/iu,
  );
  assert.equal(await exists(victimFile), true, "越界目录树必须原样保留");
  assert.equal(await exists(victimDir), true);
});

test("拒绝以受控根自身为清理目标", async () => {
  const root = getFeedbackLogArchiveDir();
  await mkdir(root, { recursive: true });

  await assert.rejects(() => cleanupLogArchive(join(root, "x.zip")), /outside/iu);
  assert.equal(await exists(root), true);
});

test('.. 穿越拒绝："<root>/archive-x/../../escape/x.zip" 不能删除根外目录', async () => {
  const root = getFeedbackLogArchiveDir();
  await mkdir(root, { recursive: true });
  const escapeDir = join(dataBaseDir, ".acode", "feedback", "escape");
  await mkdir(escapeDir, { recursive: true });
  const escapeFile = join(escapeDir, "data.txt");
  await writeFile(escapeFile, "escape", "utf-8");

  await assert.rejects(
    () => cleanupLogArchive(join(root, "archive-x", "..", "..", "escape", "x.zip")),
    /outside/iu,
  );
  assert.equal(await exists(escapeFile), true, "穿越目标必须原样保留");
});

test("幂等：受控根内不存在的归档路径清理为 no-op，不抛错", async () => {
  const root = getFeedbackLogArchiveDir();
  await mkdir(root, { recursive: true });
  await cleanupLogArchive(join(root, "archive-gone", "acode-diagnostic-logs.zip"));
  assert.equal(await exists(root), true);
});

test("端到端：prepareCompactLogArchive 产出的归档可被 cleanupLogArchive 正常清理", async () => {
  const logsDir = join(getAppConfigDir(), "logs");
  await mkdir(logsDir, { recursive: true });
  await writeFile(join(logsDir, "app.log"), "2026-10-08 hello log line\n", "utf-8");

  const archive = await prepareCompactLogArchive();
  const root = getFeedbackLogArchiveDir();
  assert.ok(archive.path.startsWith(root), "归档必须生成在受控根内");
  assert.equal(await exists(archive.path), true);

  await cleanupLogArchive(archive.path);
  assert.equal(await exists(archive.path), false, "归档文件应随父目录被清理");
  assert.equal(await exists(root), true);
});
