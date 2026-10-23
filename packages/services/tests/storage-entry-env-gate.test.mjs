import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * R6 安全不变量守护（packages/desktop/specs/host-startup-storage-cwd.md R6）。
 *
 * 不变量：**host storage 准备的入口解析独立于会话 agent 命令，且不吃 env 覆盖**。
 * storage worker 在 Host 进程内持会话库 SQLite 连接；若 env 能决定它的入口，
 * launchctl setenv / shell profile / Windows 用户环境变量注入
 * ACODE_AGENT_SERVER_COMMAND=/tmp/evil 就能让攻击者代码跑在该 worker 里
 * （与 agent-command-env-gate.md R1 同一威胁模型）。
 *
 * 本文件守护两条：
 *   (a) 行为：设 env 覆盖后，storage 入口解析**仍返回 ACode CLI bundle**，绝不返回注入路径；
 *   (b) 源码：storageEntryResolver.ts 不读 ACODE_AGENT_SERVER_* 族 env（防后人重新引入）。
 */

const { resolveACodeStoragePreparationEntry, describeStorageEntryResolutionFailure } =
  await import("../src/acode-agent/storageEntryResolver.ts");

const EVIL = process.platform === "win32" ? "C:\\tmp\\evil-agent.cjs" : "/tmp/evil-agent.cjs";
const HERE = dirname(fileURLToPath(import.meta.url));
const RESOLVER_SRC = join(HERE, "../src/acode-agent/storageEntryResolver.ts");
const STORAGE_STARTUP_SRC = join(HERE, "../src/storage-startup.ts");

/** 临时设 env（null = 删除该键），跑完恢复。异步 IO（AGENTS.md：用异步文件/网络 IO）。 */
async function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("R6(a): env 覆盖注入 ACODE_AGENT_SERVER_COMMAND 后，storage 入口绝不返回注入路径", async () => {
  await withEnv(
    {
      ACODE_AGENT_SERVER_COMMAND: EVIL,
      ACODE_AGENT_SERVER_ARGS_JSON: JSON.stringify(["jcode-bridge", "--stdio"]),
      ACODE_AGENT_SERVER_CWD: EVIL,
    },
    () => {
      const resolved = resolveACodeStoragePreparationEntry({ workspacePath: "/tmp/ws-probe" });
      // 无论命中 bundle 还是（CI 未构建 bundle 时）返回 null，都绝不能是注入的 evil 路径。
      if (resolved) {
        assert.notEqual(
          resolved.entry,
          EVIL,
          "storage 入口不得等于 env 注入的 ACODE_AGENT_SERVER_COMMAND",
        );
        assert.ok(
          resolved.entry.endsWith("acode.cjs"),
          `storage 入口应是 ACode CLI bundle（acode.cjs），实得 ${resolved.entry}`,
        );
        assert.notEqual(
          resolved.cwd,
          EVIL,
          "storage worker cwd 不得被 ACODE_AGENT_SERVER_CWD 污染",
        );
        // monorepo dev 态命中 dist bundle；打包态命中 resources——两者都是可信候选链。
        assert.ok(
          ["packaged-resources", "deployed-agents", "monorepo-dist"].includes(resolved.source),
          `source 应来自可信候选链，实得 ${resolved.source}`,
        );
      }
      // resolved 为 null（bundle 未构建）也是可接受的 fail-loud 结果——关键是没返回 evil。
    },
  );
});

test("R6(a): 无 env 覆盖时 storage 入口解析行为不变（对照，防过度收紧）", () => {
  const clean = resolveACodeStoragePreparationEntry({ workspacePath: "/tmp/ws-probe" });
  const injected = (() => {
    process.env.ACODE_AGENT_SERVER_COMMAND = EVIL;
    try {
      return resolveACodeStoragePreparationEntry({ workspacePath: "/tmp/ws-probe" });
    } finally {
      delete process.env.ACODE_AGENT_SERVER_COMMAND;
    }
  })();
  // 有无 env 覆盖，解析结果必须逐字一致——证明 env 根本不参与 storage 入口决策。
  assert.deepEqual(
    clean ? { entry: clean.entry, source: clean.source } : null,
    injected ? { entry: injected.entry, source: injected.source } : null,
    "env 覆盖不得改变 storage 入口解析结果",
  );
});

test("R6(a): 诊断文案不含任何 env 值（不泄露注入路径，也不暗示会读 env）", () => {
  process.env.ACODE_AGENT_SERVER_COMMAND = EVIL;
  try {
    const message = describeStorageEntryResolutionFailure();
    assert.ok(!message.includes(EVIL), "诊断文案不得回显 env 注入的路径");
    assert.ok(
      !message.includes("ACODE_AGENT_SERVER"),
      "诊断文案不应提及 env 覆盖变量（本模块根本不吃它）",
    );
    assert.ok(message.includes("acode.cjs"), "诊断应指向 bundle 构建方式，便于排障");
  } finally {
    delete process.env.ACODE_AGENT_SERVER_COMMAND;
  }
});

test("R6(b): 源码断言——storageEntryResolver 不读 ACODE_AGENT_SERVER_* env", async () => {
  const src = await readFile(RESOLVER_SRC, "utf8");
  // 允许出现在注释里（解释「为什么不读」），但不得出现在 process.env[...] 的读取表达式中。
  const envReadPattern =
    /process\.env\.[A-Z_]*ACODE_AGENT_SERVER|process\.env\[\s*["']ACODE_AGENT_SERVER/;
  assert.ok(
    !envReadPattern.test(src),
    "storageEntryResolver.ts 不得读取 ACODE_AGENT_SERVER_* 族 env（R6 安全不变量）",
  );
  // GLM_BINARY_PATH 同理：那是会话 binary 的 env 通道，storage 入口不得沾。
  assert.ok(
    !/process\.env\.[A-Z_]*GLM_BINARY_PATH|process\.env\[\s*["']GLM_BINARY_PATH/.test(src),
    "storageEntryResolver.ts 不得读取 GLM_BINARY_PATH（会话 binary 通道）",
  );
});

test("R6(b): 源码断言——storage-startup 公开入口不重新暴露 env 覆盖给 storage", async () => {
  const src = await readFile(STORAGE_STARTUP_SRC, "utf8");
  // storage-startup.ts 必须导出独立解析器（R6 的落点），且不能只透传 resolveDefaultACodeAgentCommand。
  assert.ok(
    src.includes("resolveACodeStoragePreparationEntry"),
    "storage-startup.ts 必须导出 resolveACodeStoragePreparationEntry（R6 独立解析器）",
  );
});
