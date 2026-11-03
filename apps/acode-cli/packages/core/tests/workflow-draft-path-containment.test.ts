// 草稿落点的容器性回归（Mimosa scan-2026-11-03 path-traversal 候选的门禁化）。
//
// 背景：扫描器把 workflow-drafts.ts:91 的 `path.join(dir, fileName)` 报为路径穿越，理由是
// 「未见根目录边界或文件名白名单校验」。裁决为误报——边界确实存在，只是形态不是扫描器找的
// `resolve` + 前缀比较，而是 join **之前**的字符白名单（WORKFLOW_DRAFT_SLUG_DROP_PATTERN，
// 丢掉 Unicode 字母/数字与 `_ . -` 之外的一切，路径分隔符与 Windows 保留字符因此都进不来）。
// 裁决依据见 docs/security/mimosa-findings-triage-2026-11.md §6.2。
//
// 但「误报」若无门禁就只是当下的一次人工判断：白名单一旦被改宽（例如为了保留某个字符而放松
// 正则），穿越就静默复活，而这条路径的输入是**模型给的工具入参**。本文件把该性质钉成测试，
// 与仓库「每项债务要么有只减不增的门禁、要么有计划文档」的原则一致。
//
// 沙箱纪律：敌意名字一律只用有限层 `..`，且 cwd 埋在临时目录的深层，于是即便白名单回归，
// 逃逸落点也仍在临时目录内——测试不会在失败之前先把文件写到真实系统路径上。
//
// 2026-11-03 追加第二类性质：文件名的 **UTF-8 字节预算**（specs/workflow-draft-filename.md R3.2）。
// 起因是本文件最后一个用例在 CI Linux 上红、在本地 Windows 上绿——同一个草稿名在 Windows 能写、
// 在 Linux 必然 ENAMETOOLONG，且被生产代码的尽力而为语义静默吞成 undefined。断言的是字节不变量
// 而非「本平台写成功了」，故这条门禁在 Windows 本地也守得住 Linux 的约束。
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WORKFLOW_DRAFTS_DIR } from "@acode/contracts";
import { writeWorkflowDraft } from "../src/tool/handlers/workflow-drafts.js";

/** 递归收集目录下所有文件的绝对路径（含隐藏文件），用于断言「没有任何东西落在容器外」。 */
async function collectFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(target);
      else out.push(target);
    }
  }
  await walk(root);
  return out;
}

/** 容器性判定：resolve + relative，要求非空、非绝对、不以 `..` 开头。 */
function assertInside(container: string, candidate: string, label: string): void {
  const relative = path.relative(container, candidate);
  assert.notEqual(relative, "", `${label}：落点等于容器本身`);
  assert.equal(path.isAbsolute(relative), false, `${label}：relative 结果为绝对路径 ${relative}`);
  assert.equal(
    relative.startsWith(".."),
    false,
    `${label}：落点越出容器（${candidate} 相对 ${container} = ${relative}）`,
  );
}

/**
 * 单个目录项的字节预算：Linux ext4 的 `NAME_MAX` = 255 **字节**，Windows NTFS 数的是 255 个 UTF-16
 * 单元，macOS 未实测（specs/workflow-draft-filename.md「已知边界」）。断言 255 字节这个公共下界，
 * 而不是「本平台写成功了」——后者正是让缺陷只在 CI Linux 上暴露、本地全绿的原因。
 */
function assertFileNameByteBudget(filePath: string, label: string): void {
  const baseName = path.basename(filePath);
  const bytes = Buffer.byteLength(baseName, "utf8");
  assert.ok(bytes <= 255, `${label}：文件名 ${bytes} 字节，超出 Linux NAME_MAX 255（${baseName.length} 个 UTF-16 单元）`);
}

/** 截断不得留下半个代理对：孤立代理项在 Windows 上是非法文件名、在 Linux 上是无效 UTF-8。 */
function assertNoLoneSurrogate(stem: string, label: string): void {
  assert.equal(stem, Array.from(stem).join(""), `${label}：截断切开了代理对，留下孤立代理项`);
}

// 敌意名字：POSIX/Windows 两种分隔符、多级上跳、绝对路径、盘符、NUL、控制字符、
// 以及「只剩点」这类会被兜底词接管的退化输入。
const HOSTILE_NAMES = [
  "../../escape-posix",
  "..\\..\\escape-windows",
  "../../../escape-deep",
  "..",
  "...",
  "-..-",
  ".\u0000./etc/passwd",
  "/etc/passwd",
  "C:\\Windows\\system32\\evil",
  "a/../../b",
  "....//....//escape",
  "\u0000evil",
  "evil\nrm -rf /",
  "con",
  "..%2f..%2fescape",
];

test("敌意草稿名不能把文件写到草稿目录之外", async (t) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "acode-draft-containment-"));
  t.after(() => rm(sandbox, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }));
  // cwd 埋在三层深，使上面所有 `..` 逃逸都仍落在 sandbox 内。
  const cwd = path.join(sandbox, "work", "a", "b");
  const draftsDir = path.join(cwd, WORKFLOW_DRAFTS_DIR);

  for (const name of HOSTILE_NAMES) {
    const result = await writeWorkflowDraft({ cwd, name, source: `// ${name}\n` });
    assert.ok(result, `名字 ${JSON.stringify(name)} 应仍能写出草稿（白名单是丢字符，不是拒绝写入）`);
    assertInside(draftsDir, result.path, `名字 ${JSON.stringify(name)}`);
    assert.equal(
      path.dirname(result.path),
      draftsDir,
      `名字 ${JSON.stringify(name)} 的落点目录不是草稿目录`,
    );
  }

  // 落点断言只覆盖返回的路径；再全量扫一遍沙箱，确认没有任何文件被写到草稿目录之外
  // （包括 `.gitignore`——它由 writeDraftGitignore 写在草稿目录内）。
  const all = await collectFiles(sandbox);
  assert.ok(all.length > 0, "沙箱内应至少有一个草稿文件");
  for (const file of all) assertInside(draftsDir, file, `沙箱内越界文件 ${file}`);
});

test("directory 覆盖同样受 slug 白名单约束", async (t) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "acode-draft-directory-"));
  t.after(() => rm(sandbox, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }));
  const cwd = path.join(sandbox, "work");
  const directory = path.join(sandbox, "fills", "x", "y");

  const result = await writeWorkflowDraft({
    cwd,
    directory,
    name: "../../escape-via-name",
    source: "// fill\n",
  });
  assert.ok(result);
  assertInside(directory, result.path, "directory 覆盖下的敌意名字");
  assert.equal(path.dirname(result.path), directory);
});

test("白名单不误伤产品意图：中文名保留、长度按码点截断、代理对不被切开", async (t) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "acode-draft-unicode-"));
  t.after(() => rm(sandbox, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }));
  const cwd = path.join(sandbox, "work");
  const draftsDir = path.join(cwd, WORKFLOW_DRAFTS_DIR);
  const stemOf = (p: string): string => path.basename(p).replace(/\.dwf\.ts$/u, "");

  // 中文名是白名单刻意放宽到 Unicode 字母的原因（源码注释：ASCII 版把每份草稿都压成 workflow-N）。
  const chinese = await writeWorkflowDraft({ cwd, name: "登录流程重构", source: "// zh\n" });
  assert.ok(chinese);
  assertInside(draftsDir, chinese.path, "中文名");
  assert.equal(stemOf(chinese.path), "登录流程重构", "中文名应被完整保留");
  assertFileNameByteBudget(chinese.path, "中文名");

  // 空白连成 `-`（源码注释的例子：`PR review #12` → `PR-review-12`）。
  const spaced = await writeWorkflowDraft({ cwd, name: "PR review #12", source: "// sp\n" });
  assert.ok(spaced);
  assert.equal(stemOf(spaced.path), "PR-review-12", "空白应连成 -，# 属白名单外被丢掉");
  assertFileNameByteBudget(spaced.path, "含空白的名字");

  // 超长按**码点**截到 64（BMP 字符：码点数 === UTF-16 单元数）。64 × 3 字节 = 192，加扩展名 199，
  // 两道预算里只有码点那道触发——这正是字节预算刻意不缩小 64 的原因：纯中文名在三平台都写得下。
  const longBmp = await writeWorkflowDraft({ cwd, name: "流".repeat(80), source: "// long\n" });
  assert.ok(longBmp);
  assert.equal(stemOf(longBmp.path), "流".repeat(64), "BMP 字符应按码点截到 64");
  assertNoLoneSurrogate(stemOf(longBmp.path), "BMP 长名");
  assertFileNameByteBudget(longBmp.path, "80 个 BMP CJK 字符");

  // astral 字符（U+20000，属 \p{L}，UTF-16 里是代理对）：**码点上限单独不足以保证可写**。
  // 64 个 astral 码点的 UTF-8 是 256 字节，加 `.dwf.ts`(7) 共 263，超过 Linux ext4 的 NAME_MAX
  // = 255 字节；而同一个名字在 Windows NTFS 上只有 135 个 UTF-16 单元，照写不误。2026-11-03 CI
  // run 41654947675 实测：Linux 上 writeWorkflowDraft 返回 undefined，ENAMETOOLONG 被尽力而为的
  // catch 静默吞掉，用户只看到「这次没有草稿」。故还有第二道字节预算：
  //   243 = 255 − 7（扩展名）− 5（最长同名后缀 `-1000`），floor(243 / 4) = 60 个码点。
  // 截断仍必须落在码点边界，否则产生孤立代理项——那在 Windows 上是非法文件名。
  const astral = "𠀀".repeat(80);
  const longAstral = await writeWorkflowDraft({ cwd, name: astral, source: "// astral\n" });
  assert.ok(longAstral, "astral 名必须在字节预算内写得下（修复前 Linux 上这里返回 undefined）");
  const astralStem = stemOf(longAstral.path);
  assert.equal(Array.from(astralStem).length, 60, "全 astral 名应按字节预算截到 60 个码点");
  assert.equal(astralStem, "𠀀".repeat(60), "截断必须落在码点边界上，不得留下半个代理对");
  assertNoLoneSurrogate(astralStem, "astral 长名");
  assertFileNameByteBudget(longAstral.path, "80 个 astral 字符");

  // 白名单只认 \p{L}\p{N} 与 `_ . -`：emoji 属 \p{So}，会被整个丢掉并落到兜底词。
  // 这是刻意保守（不是缺陷），此处把实际行为钉住，避免日后误当作 bug「修宽」正则而放进分隔符。
  const emoji = await writeWorkflowDraft({ cwd, name: "😀".repeat(10), source: "// emoji\n" });
  assert.ok(emoji);
  assert.equal(stemOf(emoji.path), "workflow", "白名单外字符全被丢掉时应落到兜底词");
  assertFileNameByteBudget(emoji.path, "兜底词");
});
