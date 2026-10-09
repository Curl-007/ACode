import { promises as fs } from "node:fs";
import path from "node:path";

import { gitFileNames } from "./git-file-names.mjs";

export async function readBaseline(cwd) {
  try {
    return JSON.parse(await fs.readFile(path.join(cwd, ".architecture-baseline.json"), "utf8"));
  } catch {
    return { version: 1, violations: [] };
  }
}

export async function updateBaseline({ cwd = process.cwd(), violations }) {
  const entries = [...violations].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  const filename = path.join(cwd, ".architecture-baseline.json");
  await fs.writeFile(filename, `${JSON.stringify({ version: 1, violations: entries }, null, 2)}\n`);
  return entries;
}

export async function changedFilesFromGit(cwd = process.cwd()) {
  const [diff, untracked] = await Promise.all([
    gitFileNames(cwd, ["diff", "--name-only", "-z", "HEAD"]),
    gitFileNames(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return [...new Set([...diff, ...untracked])];
}
