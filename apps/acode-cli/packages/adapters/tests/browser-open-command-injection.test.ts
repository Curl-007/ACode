// R2-01（Windows OAuth authorize_url 命令注入）修复守护测试。
//
// 根因：browser.ts win32 分支原用 `cmd.exe /c start "" <url>`，cmd.exe 按 `"` 切换引号态，
// 网络返回的 authorize_url 内嵌裸双引号即可逃逸执行后续命令（如 `&calc&`）。修复改用
// explorer.exe 直传（非 shell，argv 经 CreateProcess 传递，无元字符解释层），对齐同仓
// bootstrap/src/app/platform-open-port.ts 的 H1 修复模式。
//
// 两类断言：(1) 源码不变量——防止回归到 cmd.exe+start 漏洞写法；(2) 行为——注入假 spawn
// port，构造含 `"` 与 `&` 的恶意 URL，断言 win32 分支产出 explorer.exe + 单个完整 URL 参数。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openUrlInBrowser } from "../src/auth/browser.js";

const BROWSER_SOURCE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/auth/browser.ts",
);

// 恶意 URL：内嵌裸双引号（cmd.exe 引号态逃逸入口）+ & 命令分隔符（逃逸后执行 calc）。
const MALICIOUS_URL = 'https://x/?q="&calc&"';

interface SpawnCall {
  executable: string;
  args: string[];
}

// 假 spawn port：捕获 argv，返回一个立即 emit "spawn" 的假 ChildProcess，
// 使 waitForBrowserSpawn 判定 opened=true，全程不真启动任何进程。
function createFakeSpawn(sink: SpawnCall[]): typeof spawn {
  const fake = (executable: string, args: readonly string[]): ChildProcess => {
    sink.push({ executable, args: [...args] });
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = (): void => undefined;
    // listener 在 spawnProcess 返回后由 waitForBrowserSpawn 同步注册；setImmediate 保证
    // emit 发生在注册之后。
    setImmediate(() => child.emit("spawn"));
    return child as unknown as ChildProcess;
  };
  return fake as unknown as typeof spawn;
}

test("R2-01 不变量：browser.ts 源码不再出现 cmd.exe + start 漏洞组合", () => {
  const source = readFileSync(BROWSER_SOURCE_PATH, "utf8");
  // 精确匹配「cmd.exe 作为 executable 值」的 return 形态，不误伤注释中的历史说明文本。
  assert.ok(
    !/executable:\s*["']cmd(?:\.exe)?["']/.test(source),
    "win32 分支不得以 cmd.exe 作为 executable（命令注入回归）",
  );
  assert.ok(
    !/["']start["']/.test(source),
    '不得出现 "start" 作为参数字面量（cmd start 漏洞写法）',
  );
  assert.ok(
    source.includes("explorer.exe"),
    "win32 分支应改用 explorer.exe 直传（对齐 platform-open-port.ts H1 修复）",
  );
});

test("R2-01 行为：恶意 URL 在 win32 分支经 explorer.exe 单参数直传，不经 shell", async () => {
  const calls: SpawnCall[] = [];
  const result = await openUrlInBrowser(MALICIOUS_URL, {
    platform: "win32",
    spawnProcess: createFakeSpawn(calls),
  });

  assert.equal(result.opened, true, "explorer.exe spawn 成功即判 opened");
  assert.equal(calls.length, 1, "只 spawn 一次");
  assert.equal(calls[0]?.executable, "explorer.exe", "executable 为非 shell 的 explorer.exe");
  // 关键：URL 作为单个完整 argv 参数原样传递，未被拆分/转义/交给 shell 解释。
  assert.deepEqual(calls[0]?.args, [MALICIOUS_URL], "argv 为单个完整 URL 参数");
});

test("R2-01 行为：非 win32 分支保持原有 opener（darwin=open / linux=xdg-open）", async () => {
  const darwinCalls: SpawnCall[] = [];
  await openUrlInBrowser("https://ok.example/path", {
    platform: "darwin",
    spawnProcess: createFakeSpawn(darwinCalls),
  });
  assert.equal(darwinCalls[0]?.executable, "open");
  assert.deepEqual(darwinCalls[0]?.args, ["https://ok.example/path"]);

  const linuxCalls: SpawnCall[] = [];
  await openUrlInBrowser("https://ok.example/path", {
    platform: "linux",
    spawnProcess: createFakeSpawn(linuxCalls),
  });
  assert.equal(linuxCalls[0]?.executable, "xdg-open");
  assert.deepEqual(linuxCalls[0]?.args, ["https://ok.example/path"]);
});
