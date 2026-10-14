// 构建产物清理（specs/windows-helper-producer.md §5.2）：只用 node 内建 fs.rm，
// 移除 dist/（tsc 输出）与 build/（node-gyp 构建树）。二者均不入库（§5.4）。
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const producerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await rm(join(producerRoot, "dist"), { recursive: true, force: true });
await rm(join(producerRoot, "build"), { recursive: true, force: true });
