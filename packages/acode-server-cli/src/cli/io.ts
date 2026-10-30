// 2026-12-31 例外债务偿还（onboard-server-cli-over-limit）：自 ../cli.ts 拆出。
// 职责：CLI 宿主 IO 注入面（CliIO / ServerCliRuntimeOptions）与 stdout/stderr 写助手。
// 独立成叶是因为 cli.ts 编排层与各子命令叶子都要消费它们；放在最底层可避免
// 子命令叶子反向 import cli.ts 形成模块环。
import { type BundledAgentWiring } from "../runtime/agentWiring.js";

export interface CliIO {
  stdout?: { write(value: string): void };
  stderr?: { write(value: string): void };
  confirm?: (prompt: string) => Promise<string>;
  legacyDelegate?: (argv: readonly string[]) => Promise<number>;
}

export interface ServerCliRuntimeOptions {
  bundledAgentWiring?: BundledAgentWiring | null;
}

export const stdout = (io: CliIO, value: unknown): void =>
  io.stdout?.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
export const stderr = (io: CliIO, value: unknown): void =>
  io.stderr?.write(`${value instanceof Error ? value.message : String(value)}\n`);
