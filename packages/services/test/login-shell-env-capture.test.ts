// login shell 采集的 SHELL 解析基准一致性回归。
//
// 根因（specs/agent-command-env-gate.md R3 追记，2026-11-03）：`isExecutableFile` 的
// accessSync 按 **cwd** 解析相对名，而 `spawn` 收到的裸名按**子进程 env.PATH** 解析，两者
// 解析基准不同——校验的文件与将要执行的文件可能不是同一个。收口为「SHELL 必须是绝对路径
// 才进候选」。
//
// 这不改变 R3 的既有裁决（SHELL 在打包态保留：login env 采集的功能本体就是跑用户自己的
// shell，门禁它会破坏 fish/自定义 shell 用户）。正常登录 shell 的 SHELL 来自 passwd 条目、
// 恒为绝对路径，故第二个用例专门钉住「绝对路径的自定义 shell 仍被采用」，防止收口过度。
//
// 平台无关性：被测函数在 win32 直接短路，故一律用 `platform: "linux"` 注入走 POSIX 分支，
// 并用 `executeShell` 注入替身——只观察「选了哪个 shellPath」，不真的起 shell。
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { captureLoginShellEnvSnapshot } from "../src/runtime-tools/runtimeLoginShellEnvCapture.js";

const FALLBACKS = ["/bin/zsh", "/bin/bash", "/bin/sh"];

/** 沙箱内文件名白名单：只允许安全字符，且不允许纯点（`.`/`..` 是目录项，不是文件名）。 */
const SANDBOX_BASENAME = /^[A-Za-z0-9_-]+$/;

/**
 * 在沙箱根内拼一个路径，并**证明**它没有越界。
 *
 * 本文件的入参全是测试自己的字面量，不含外部输入；仍做白名单 + 容器校验，是因为「写入目标
 * 必须可证明落在预期根内」正是本测试所断言的性质，测试自身不应享有豁免。
 */
function containedPath(root: string, segment: string): string {
  assert.match(segment, SANDBOX_BASENAME, `非法沙箱文件名：${segment}`);
  const target = path.resolve(root, segment);
  assert.equal(
    target.startsWith(root + path.sep),
    true,
    `拼出的路径越出沙箱根：${target} 不在 ${root} 内`,
  );
  return target;
}

async function createSandbox(
  t: { after(fn: () => unknown): void },
  prefix: string,
): Promise<string> {
  assert.match(prefix, SANDBOX_BASENAME, `非法沙箱前缀：${prefix}`);
  const dir = await mkdtemp(path.resolve(tmpdir(), `${prefix}-`));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }));
  return dir;
}

/** 放一个「看起来可执行」的文件。Windows 无执行位，accessSync(X_OK) 退化为存在性检查，
 *  这反而让相对名用例在 Windows 上更有鉴别力：未收口时它必然通过校验。 */
async function plantExecutable(dir: string, name: string): Promise<string> {
  const target = containedPath(dir, name);
  await writeFile(target, "#!/bin/sh\necho planted\n", "utf8");
  await chmod(target, 0o755);
  return target;
}

async function captureWithSpy(baseEnv: NodeJS.ProcessEnv): Promise<string[]> {
  const calls: string[] = [];
  await captureLoginShellEnvSnapshot({
    baseEnv,
    platform: "linux",
    executeShell: async (shellPath) => {
      calls.push(shellPath);
      return "";
    },
  });
  return calls;
}

test("相对 SHELL 不被采用，即使 cwd 下存在同名可执行文件", async () => {
  assert.match("acode-login-shell-relative", SANDBOX_BASENAME);
  const dir = await mkdtemp(path.resolve(tmpdir(), "acode-login-shell-relative-"));
  await plantExecutable(dir, "zsh");

  // accessSync 以 cwd 为基准解析相对名，故必须真的把 cwd 切到植入目录，
  // 否则未收口的实现也会因为找不到 ./zsh 而落到兜底链，用例就没有鉴别力。
  // 清理用 try/finally 而非 t.after：after 钩子按注册顺序执行，而 Windows 不能删除
  // 「当前工作目录」，必须保证先 chdir 出去再 rm，否则 EBUSY。
  const originalCwd = process.cwd();
  try {
    process.chdir(dir);
    const calls = await captureWithSpy({ SHELL: "zsh" });
    assert.equal(
      calls.includes("zsh"),
      false,
      "相对 SHELL 不得被选中：校验基准(cwd)与执行基准(PATH)不一致",
    );
    for (const called of calls) {
      assert.equal(path.isAbsolute(called), true, `选中的 shell 必须是绝对路径，实际 ${called}`);
      assert.equal(FALLBACKS.includes(called), true, `只能落到固定兜底链，实际 ${called}`);
    }
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
  }
});

test("绝对路径的自定义 shell 仍被采用（收口不得破坏 fish/自定义 shell 用户）", async (t) => {
  const dir = await createSandbox(t, "acode-login-shell-absolute");
  const custom = await plantExecutable(dir, "fish");

  const calls = await captureWithSpy({ SHELL: custom });
  assert.deepEqual(calls, [custom], "绝对路径且存在可执行的 SHELL 必须原样采用");
});

test("绝对路径但不存在的 SHELL 落到固定兜底链", async (t) => {
  const dir = await createSandbox(t, "acode-login-shell-missing");
  const missing = path.resolve(dir, "absent-shell");

  const calls = await captureWithSpy({ SHELL: missing });
  // Linux 上 /bin/sh 一类必然存在故有一次调用；Windows 上兜底项都不存在，解析为 null、
  // 采集直接返回，spy 不会被调用。两种都合法，但都不得回落到那个不存在的路径。
  assert.equal(calls.includes(missing), false);
  for (const called of calls) {
    assert.equal(FALLBACKS.includes(called), true, `只能落到固定兜底链，实际 ${called}`);
  }
});

test("SHELL 缺席时走固定兜底链", async () => {
  const calls = await captureWithSpy({});
  for (const called of calls) {
    assert.equal(FALLBACKS.includes(called), true, `只能落到固定兜底链，实际 ${called}`);
  }
});
