#!/usr/bin/env node
/**
 * 两个 AgentTeams 冒烟脚本（smoke.mjs / smoke-acceptance.mjs）的共用驱动层：
 * 真实 stdio 拉起构建后的 dist/mcp/server.js（与宿主 adapter 同一条协商链路，
 * 含 server/discover 版本协商）、插件状态通知捕获、断言器、结果解析与真实 git 辅助。
 *
 * 只搬「两脚本同源的不变量样板」，各脚本的流程与断言仍留在各自文件里：任一
 * 协商/轮询/断言修 bug 都要同步两遍是本层要消除的重复。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

/** 建一个隔离的临时工作区（脚本自行清理）。 */
export const createWorkspace = (prefix) => mkdtempSync(join(tmpdir(), prefix));

/**
 * 真实 stdio 拉起 dist/mcp/server.js。server 侧 legacy: "reject"（与 node-repl-host
 * 相同）；pin 2026-07-28 对齐宿主 adapter 对现代 server 的协商结果（auto 模式对
 * reject server 的等效路径）。args 以本文件所在目录解析（与各脚本同目录）。
 */
export const startAgentTeamsClient = ({ workspace, name, version = "0" }) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dirname, "..", "dist", "mcp", "server.js")],
    env: { ...process.env, ACODE_PROJECT_DIR: workspace },
  });
  const client = new Client(
    { name, version },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  return { client, transport };
};

/**
 * 截获插件状态通知（acode-plugin-state:* logging 通知 → 宿主桥的前半段）并按谓词
 * 轮询等待。notifications 供瞬时断言，waitForPluginState 供「某帧尚未到达」的等待。
 */
export const capturePluginState = (client) => {
  const notifications = [];
  client.setNotificationHandler("notifications/message", (notification) => {
    const params = notification.params ?? {};
    if (typeof params.logger === "string" && params.logger.startsWith("acode-plugin-state:")) {
      notifications.push({ logger: params.logger, data: params.data });
    }
  });
  const waitForPluginState = (predicate, timeoutMs = 10000) =>
    new Promise((resolvePromise, reject) => {
      const startedAt = Date.now();
      const poll = () => {
        const found = notifications.find(predicate);
        if (found) {
          resolvePromise(found);
          return;
        }
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error("plugin state notification not observed in time"));
          return;
        }
        setTimeout(poll, 100);
      };
      poll();
    });
  return { notifications, waitForPluginState };
};

/** 断言器：打印 PASS/FAIL 并累计失败数；crash 记录崩溃，finish 输出总结并退出。 */
export const createChecker = ({ okLabel = "SMOKE", crashLabel = "smoke" } = {}) => {
  let failures = 0;
  const check = (label, condition) => {
    console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
    if (!condition) failures += 1;
  };
  return {
    check,
    /** 打印真实事实（SHA 等），便于人工核对与留痕。 */
    note: (label, value) => console.log(`INFO  ${label}: ${value}`),
    crash: (error) => {
      failures += 1;
      console.log(`FAIL  ${crashLabel} crashed: ${error.message}`);
    },
    finish: () => {
      console.log(failures === 0 ? `\n${okLabel} OK` : `\n${okLabel} FAILED (${failures})`);
      process.exit(failures === 0 ? 0 : 1);
    },
  };
};

/** tools/call 结果解析：ok:false 抛错（沿用原脚本语义），否则返回解析后的对象。 */
export const parseResult = (result) => {
  const parsed = JSON.parse(result.content[0].text);
  if (parsed.ok === false) throw new Error(`tool ${parsed.error.code}: ${parsed.error.message}`);
  return parsed;
};

/** 只取错误体（不抛错），用于负向断言。 */
export const errorOf = (result) => JSON.parse(result.content[0].text).error;

// ---- 真实 git（acceptance 冒烟用；execFileSync，局部用户配置，不污染全局） ----
export const runGit = (cwd, args, { allowFailure = false } = {}) => {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout };
  } catch (error) {
    if (!allowFailure) {
      throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${error.stderr ?? error.message}`);
    }
    return { ok: false, stdout: typeof error.stdout === "string" ? error.stdout : "" };
  }
};

export const git = (cwd, args) => runGit(cwd, args).stdout.trim();

/** 归一化路径比较（git porcelain 与产品句柄可能分别是正/反斜杠、盘符大小写）。 */
export const normPath = (value) => resolve(value).replace(/\\/gu, "/").toLowerCase();

/** 该路径是否是 git 登记的 worktree（与 manager.listRegisteredWorktrees 同源判据）。 */
export const isRegisteredWorktree = (repoRoot, path) =>
  git(repoRoot, ["worktree", "list", "--porcelain"])
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree "))
    .some((line) => normPath(line.slice("worktree ".length)) === normPath(path));