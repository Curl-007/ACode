/**
 * ready（§R6，EXP1 实证子转录链路）：子代理汇报结构。判分对象 = 实现子会话转录。
 * 语料 setup：任意实现/研究任务；子最终消息须 specifics-first、含可转述一句、
 * verified 与 intended 分明。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const mode = "yolo";
export const judgeTarget = "child";
export const parentPrompt = "Dispatch an agent to add a retry helper to src/http/client.ts and report back.";

export async function setup(dir) {
  mkdirSync(join(dir, "src", "http"), { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "retry-fixture", private: true, type: "module" }, null, 2)}\n`, "utf-8");
  writeFileSync(
    join(dir, "src", "http", "client.ts"),
    `export async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(\`http \${response.status}\`);
  return response.json();
}
`,
    "utf-8",
  );
  writeFileSync(join(dir, "README.md"), "# retry fixture\n\nAsk for a retry helper in src/http/client.ts.\n", "utf-8");
}
