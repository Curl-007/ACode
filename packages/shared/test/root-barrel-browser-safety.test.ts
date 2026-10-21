// specs/git-invocation-hardening.md R7 守卫：@acode/shared 根 barrel 的传递导入图
// 不得含 node-only 模块（renderer/preload 构建面会崩：vite browser-external 抛错、
// sandboxed preload require 缺内置模块——2026-10-21 dev:desktop 手验实证，
// git-invocation-env 曾经根 barrel 泄漏）。node-only 面一律挂 ./node 桶。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../src");

const NODE_PROTOCOL = /from\s+"node:[^"]+"|import\s+"node:[^"]+"|require\(\s*"node:[^"]+"\s*\)/;
const BARE_NODE_BUILTINS =
  /from\s+"(?:path|fs|os|crypto|child_process|worker_threads|net|http|https|url|util|stream|events|module|process|vm|zlib|tls|dns|assert|buffer|perf_hooks|timers|tty|v8)"\s*;/;

function localSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/(?:from|import)\s+"(\.[^"]+)"|require\(\s*"(\.[^"]+)"\s*\)/g)) {
    out.push(m[1] ?? m[2]!);
  }
  return out;
}

function collectReachable(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    const source = readFileSync(current, "utf8");
    seen.set(current, source);
    for (const specifier of localSpecifiers(source)) {
      const base = resolve(dirname(current), specifier);
      for (const candidate of [base.replace(/\.js$/, ".ts"), base + ".ts", base]) {
        if (!seen.has(candidate)) {
          try {
            readFileSync(candidate);
            queue.push(candidate);
            break;
          } catch {
            // 候选不存在换下一个
          }
        }
      }
    }
  }
  return seen;
}

test("shared 根 barrel 传递导入图无 node-only 模块（R7 守卫）", () => {
  const reachable = collectReachable(resolve(SRC, "index.ts"));
  const violations: string[] = [];
  for (const [file, source] of reachable) {
    if (NODE_PROTOCOL.test(source) || BARE_NODE_BUILTINS.test(source)) {
      violations.push(file.replace(SRC, "src"));
    }
  }
  assert.deepEqual(
    violations,
    [],
    `根 barrel 泄漏 node-only 模块（renderer/preload 构建面崩溃源）：${violations.join(", ")}；改挂 ./node 桶`,
  );
});

test("shared ./node 桶承载 git-invocation-env 与 managedPolicy（R7 落点钉住）", () => {
  const nodeBucket = readFileSync(resolve(SRC, "node.ts"), "utf8");
  assert.match(nodeBucket, /export \* from "\.\/git-invocation-env\.js"/);
  assert.match(nodeBucket, /managedPolicy\.js/);
  const rootBarrel = readFileSync(resolve(SRC, "index.ts"), "utf8");
  assert.doesNotMatch(rootBarrel, /git-invocation-env\.js/);
});
