import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { posix } from "./policy.mjs";

// 测试/评测文件不参与「超限文件只减不增」基线，避免门禁阻碍补测试。
export const RATCHET_EXEMPT_PATTERN =
  /(?:\.test\.[cm]?[jt]sx?$)|(?:^|\/)(?:tests?|__tests__|evals)(?:\/|$)/;
const execFileAsync = promisify(execFile);

/** Count physical lines without treating a terminal newline as an extra line. */
export function countPhysicalLines(source) {
  return source
    .split(/\r?\n/)
    .filter((line, index, lines) => index < lines.length - 1 || line !== "").length;
}

export async function gitHeadLineCount(cwd, file) {
  const relative = posix(path.relative(cwd, file));
  if (!relative || relative.startsWith("..")) return null;
  try {
    const { stdout } = await execFileAsync("git", ["show", `HEAD:${relative}`], {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return countPhysicalLines(stdout);
  } catch {
    return null;
  }
}
