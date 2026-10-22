import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ArchivePolicyViolationError } from "@acode/shared/node";
import { SKILL_SYNC_SIZE_LIMIT_ERROR_CODE } from "@acode/shared";
import {
  createSkillSyncArchive,
  extractSkillSyncArchive,
} from "../src/skill-sync/skillSyncArchive.js";

/**
 * skill sync 归档解包信任档（local 档）守护测试。
 * 规格：packages/services/specs/file-containment-trust-tiers.md R4/R6.3。
 */

// 临时目录清理：此前多处 mkdtemp（源树/目标根）后全程无清理，CI 累积占盘
// （协调项，来自 CI/测试基建代理）。用模块级登记表 + 顶层 after 钩子统一删除，
// 避免逐个 mkdtemp 调用点串 t.after。
const tempDirs: string[] = [];
after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function trackMkdtemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createSourceTree(files: Record<string, string>): Promise<string> {
  const sourceRoot = await trackMkdtemp("acode-skill-sync-src-");
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(sourceRoot, ...relativePath.split("/"));
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }
  return sourceRoot;
}

function toArchiveEntries(sourceRoot: string, relativePaths: readonly string[]) {
  return relativePaths.map((archivePath) => ({
    archivePath,
    sourcePath: join(sourceRoot, ...archivePath.split("/")),
  }));
}

function violationReason(error: unknown): string | undefined {
  return error instanceof ArchivePolicyViolationError ? error.reason : undefined;
}

test("round-trip：打包→解包内容保真；OS 垃圾条目跳过不落盘", async () => {
  const sourceRoot = await createSourceTree({
    "myskill/.DS_Store": "junk",
    "myskill/SKILL.md": "# skill body",
    "myskill/scripts/run.sh": "echo ok",
  });
  const archive = await createSkillSyncArchive(
    toArchiveEntries(sourceRoot, [
      "myskill/SKILL.md",
      "myskill/scripts/run.sh",
      "myskill/.DS_Store",
    ]),
  );

  const targetRoot = await trackMkdtemp("acode-skill-sync-dst-");
  await extractSkillSyncArchive(archive, targetRoot);

  assert.equal(
    await readFile(join(targetRoot, "myskill", "SKILL.md"), "utf8"),
    "# skill body",
  );
  assert.equal(
    await readFile(join(targetRoot, "myskill", "scripts", "run.sh"), "utf8"),
    "echo ok",
  );
  await assert.rejects(
    () => stat(join(targetRoot, "myskill", ".DS_Store")),
    "垃圾条目必须被跳过，不落盘",
  );
});

test("归一化碰撞：A.txt 与 a.txt 同档拒绝（name_collision）", async () => {
  const sourceRoot = await createSourceTree({
    "myskill/A.txt": "upper",
    "myskill/a.txt": "lower",
  });
  const archive = await createSkillSyncArchive(
    toArchiveEntries(sourceRoot, ["myskill/A.txt", "myskill/a.txt"]),
  );
  const targetRoot = await trackMkdtemp("acode-skill-sync-dst-");
  await assert.rejects(
    () => extractSkillSyncArchive(archive, targetRoot),
    (error: unknown) => violationReason(error) === "name_collision",
  );
});

test("wx 独占写兜底：目标目录已存在同名文件时拒绝覆盖", async () => {
  const sourceRoot = await createSourceTree({ "myskill/keep.txt": "new" });
  const archive = await createSkillSyncArchive(toArchiveEntries(sourceRoot, ["myskill/keep.txt"]));
  const targetRoot = await trackMkdtemp("acode-skill-sync-dst-");
  await mkdir(join(targetRoot, "myskill"), { recursive: true });
  await writeFile(join(targetRoot, "myskill", "keep.txt"), "pre-existing", "utf8");

  await assert.rejects(
    () => extractSkillSyncArchive(archive, targetRoot),
    /collides after filesystem name normalization/u,
  );
  assert.equal(
    await readFile(join(targetRoot, "myskill", "keep.txt"), "utf8"),
    "pre-existing",
    "wx 兜底拒绝后既有文件必须原样保留",
  );
});

test("总量上限：SkillSyncSizeLimitError 形状保留（code + extracted-content 阶段）", async () => {
  const sourceRoot = await createSourceTreeWithLargeFile();
  const archive = await createSkillSyncArchive(
    toArchiveEntries(sourceRoot, ["myskill/big.md"]),
  );
  const targetRoot = await trackMkdtemp("acode-skill-sync-dst-");
  await assert.rejects(
    () => extractSkillSyncArchive(archive, targetRoot, { maxExtractedBytes: 16 }),
    (error: unknown) => {
      const limitError = error as { code?: string; data?: { phase?: string } };
      assert.equal(limitError.code, SKILL_SYNC_SIZE_LIMIT_ERROR_CODE);
      assert.equal(limitError.data?.phase, "extracted-content");
      return true;
    },
  );
});

async function createSourceTreeWithMode(
  files: Record<string, { content: string; mode?: number }>,
): Promise<string> {
  const sourceRoot = await trackMkdtemp("acode-skill-sync-src-");
  for (const [relativePath, descriptor] of Object.entries(files)) {
    const fullPath = join(sourceRoot, ...relativePath.split("/"));
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, descriptor.content, "utf8");
    if (descriptor.mode !== undefined) {
      await chmod(fullPath, descriptor.mode);
    }
  }
  return sourceRoot;
}

async function createSourceTreeWithLargeFile(): Promise<string> {
  return await createSourceTreeWithMode({
    "myskill/big.md": { content: "x".repeat(4096) },
  });
}

test(
  "可执行位策略：owner-exec 条目解包后收敛为 0o700；非 exec 条目不加执行位",
  { skip: process.platform === "win32" ? "Windows 无 unix exec 位语义" : false },
  async () => {
    const sourceRoot = await createSourceTreeWithMode({
      "myskill/bin/run.sh": { content: "#!/bin/sh\n", mode: 0o755 },
      "myskill/notes.md": { content: "notes", mode: 0o644 },
    });
    const archive = await createSkillSyncArchive(
      toArchiveEntries(sourceRoot, ["myskill/bin/run.sh", "myskill/notes.md"]),
    );
    const targetRoot = await trackMkdtemp("acode-skill-sync-dst-");
    await extractSkillSyncArchive(archive, targetRoot);

    const execStats = await stat(join(targetRoot, "myskill", "bin", "run.sh"));
    assert.equal(execStats.mode & 0o777, 0o700);
    const plainStats = await stat(join(targetRoot, "myskill", "notes.md"));
    assert.equal(plainStats.mode & 0o111, 0, "非 exec 条目不得带执行位");
  },
);

test("local 档词法闸：../ 与反斜杠条目名拒绝（既有错误消息形状保留）", async () => {
  const sourceRoot = await createSourceTree({ "myskill/SKILL.md": "body" });
  // createSkillSyncArchive 打包面先拒（同一 normalize 权威），解包面独立验证会话词法。
  await assert.rejects(
    () =>
      createSkillSyncArchive([
        { archivePath: "../escape.md", sourcePath: join(sourceRoot, "myskill", "SKILL.md") },
      ]),
    /unsafe skill archive path/u,
  );
  await assert.rejects(
    () =>
      createSkillSyncArchive([
        { archivePath: "dir\\evil.md", sourcePath: join(sourceRoot, "myskill", "SKILL.md") },
      ]),
    /unsafe skill archive path/u,
  );
});
