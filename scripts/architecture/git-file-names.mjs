import { spawn } from "node:child_process";

/**
 * 跑一个输出 NUL 分隔路径的 git 命令并流式收集结果。
 *
 * stdin 非 null 时把内容写入子进程标准输入（`check-ignore --stdin` 一类需要喂路径的命令），
 * 走 stdin 而非 argv 是为了绕开 Windows ~32KB 的命令行长度上限——全仓源码路径有数千条。
 * okCodes 用于容纳「非零但不是错误」的退出码：`git check-ignore` 以 1 表示
 * 「没有任何路径被忽略」，这是正常结果。默认 [0] 保持既有调用方语义不变。
 */
export function gitFileNames(cwd, args, { stdin = null, okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const files = [];
    let pending = "";
    let stderr = "";
    // CI 持久缓存曾让 execFile 的 1 MiB 输出缓冲区溢出；流式消费路径，NUL 分隔避免转义和空白损坏。
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const names = (pending + chunk).split("\0");
      pending = names.pop() ?? "";
      for (const name of names) if (name) files.push(name);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-16 * 1024);
    });
    if (stdin !== null) {
      // git 可能在读完输入前就退出（参数错误等），EPIPE 不能掀翻本进程。
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    }
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (!okCodes.includes(code)) {
        reject(new Error(`git ${args.join(" ")} failed (${signal ?? code}): ${stderr.trim()}`));
        return;
      }
      if (pending) files.push(pending);
      resolve(files);
    });
  });
}
