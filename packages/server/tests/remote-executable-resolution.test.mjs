// 宿主侧可执行文件解析的加固回归（specs/remote-deploy-hardening.md R4，验收 6/7/8）。
//
// 威胁模型：Windows CreateProcess 解析裸名的顺序是「调用方 exe 目录 → **当前目录** →
// System32 → …」，当前目录排在 System32 之前；POSIX 侧 PATH 含相对条目时 join 出的候选同样按
// cwd 解析。两者都构成工作目录二进制种植面，与 agent-teams-plugin 的 run_checks 已明确排除的
// 是同一类风险（docs/security/mimosa-findings-triage-2026-11.md §6.1 ④）。
//
// resolveDockerCommand 支持 platform/env/isExecutable 全注入，故 docker 侧可确定性断言；
// resolveWslCommand 读真实 process.platform 与 SystemRoot，故只断言其**可观察契约**
// （绝对路径或文档化的裸名回退 + memoized），并以静态扫描守住「无裸名 spawn 站点」。
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveDockerCommand } from "../src/remote/docker-detect.ts";
import { resolveWslCommand, WSL_COMMAND } from "../src/remote/wslBackendSupport.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const remoteDir = path.join(repoRoot, "packages/server/src/remote");

test("R4.3 docker：PATH 中的相对条目被跳过，不返回按 cwd 解析的候选", () => {
  // isExecutable 恒真：只要解析器愿意考虑相对条目，它就会命中第一个（"."），
  // 于是本断言在未加固时必然失败——用例具备鉴别力。
  const resolved = resolveDockerCommand({
    platform: "win32",
    env: { PATH: `.${path.delimiter}bin${path.delimiter}C:\\real-bin` },
    isExecutable: () => true,
    homeDir: "C:\\Users\\tester",
  });
  assert.equal(
    resolved,
    path.win32.join("C:\\real-bin", "docker.exe"),
    `应跳过 "." 与 "bin" 两个相对条目、返回第一个绝对条目下的候选，实际 ${resolved}`,
  );
  assert.equal(path.win32.isAbsolute(resolved), true);
});

test("R4.3 docker：posix 侧同样跳过相对条目", () => {
  const resolved = resolveDockerCommand({
    platform: "linux",
    env: { PATH: ".:bin:/usr/bin" },
    isExecutable: () => true,
    homeDir: "/home/tester",
  });
  assert.equal(resolved, "/usr/bin/docker");
  assert.equal(path.posix.isAbsolute(resolved), true);
});

test("R4.3 docker：PATH 只有绝对条目时行为与加固前一致（按序取第一个可执行）", () => {
  const resolved = resolveDockerCommand({
    platform: "linux",
    env: { PATH: "/opt/docker/bin:/usr/bin" },
    // 只有第二个条目里"存在"docker：验证仍是按序探测，而不是无脑取第一个。
    isExecutable: (candidate) => candidate === "/usr/bin/docker",
    homeDir: "/home/tester",
  });
  assert.equal(resolved, "/usr/bin/docker");
});

test("R4.4 残余：PATH 与固定安装位置都找不到时仍返回裸名（既有回退，登记在案）", () => {
  const resolved = resolveDockerCommand({
    platform: "linux",
    env: { PATH: "/nonexistent" },
    isExecutable: () => false,
    homeDir: "/home/tester",
  });
  assert.equal(resolved, "docker", "回退语义不得因加固而改变，否则调用方错误处理会跟着变");
});

test("R4.2 wsl：resolveWslCommand 返回绝对路径或文档化的裸名回退，且 memoized", async () => {
  const first = await resolveWslCommand();
  const second = await resolveWslCommand();
  assert.equal(first, second, "memoized：同一进程内多次调用必须一致");

  if (first === WSL_COMMAND) {
    // 回退分支：非 win32、SystemRoot 缺失、或 System32 下没有 wsl.exe（未安装 WSL 的机器）。
    assert.equal(first, "wsl.exe");
    return;
  }
  assert.equal(
    path.isAbsolute(first),
    true,
    `非回退时必须是绝对路径（消除 cwd 种植面），实际 ${first}`,
  );
  assert.equal(
    path.basename(first).toLowerCase(),
    "wsl.exe",
    `绝对路径仍须指向 wsl.exe，实际 ${first}`,
  );
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "";
    assert.equal(
      first.toLowerCase(),
      path.join(systemRoot, "System32", "wsl.exe").toLowerCase(),
      "win32 上应解析到 System32，而不是 PATH 或 cwd 里的同名文件",
    );
  }
});

test("R4.2/验收8：仓库内不存在以裸名 wsl.exe 直接 spawn/execFile 的站点", () => {
  const offenders = [];
  for (const name of readdirSync(remoteDir)) {
    if (!name.endsWith(".ts")) continue;
    const file = path.join(remoteDir, name);
    const text = readFileSync(file, "utf8");
    // 裸名字面量直接作为 spawn/execFile 首参：CreateProcess 会把 cwd 排在 System32 之前。
    if (/(?:spawn|execFile)\(\s*["']wsl(?:\.exe)?["']/i.test(text)) offenders.push(name);
    // 常量被直接当首参（而非经 resolveWslCommand）同样算违规。
    if (/(?:spawn|execFile)\(\s*WSL_COMMAND\b/.test(text)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], `以下文件仍以裸名/常量直接启动 wsl.exe：${offenders.join(", ")}`);
});

test("R4.2/验收8：WSL_COMMAND 只有一处声明（单一写入路径）", () => {
  const declarations = [];
  for (const name of readdirSync(remoteDir)) {
    if (!name.endsWith(".ts")) continue;
    const text = readFileSync(path.join(remoteDir, name), "utf8");
    if (/^\s*(?:export\s+)?const\s+WSL_COMMAND\s*=/m.test(text)) declarations.push(name);
  }
  assert.deepEqual(
    declarations,
    ["wslBackendSupport.ts"],
    `WSL_COMMAND 必须只在 wslBackendSupport.ts 声明一份，实际：${declarations.join(", ")}`,
  );
});
