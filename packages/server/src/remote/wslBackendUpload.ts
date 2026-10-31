// 拆分依据：wsl-backend.ts 超 400 行架构上限。`cat > file` 流式上传（无进度回退 + 带进度/可取消两条
// 形态）是独立的传输逻辑，独立成叶子；行为逐点等价：未传 options 时不做 stat/进度/取消监听，
// 与原 UNC 失败回退路径一致；传 options（onProgress/signal）时与原 uploadViaExec 一致。
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { posix } from "node:path";
import type { RemoteUploadOptions, StdioStream } from "@acode/server/remote/backend.js";
import { quotePosixShellArg } from "@acode/server/remote/posixShell.js";

export async function uploadFileViaWslCatStream(params: {
  localPath: string;
  resolvedRemotePath: string;
  exec: (command: string) => Promise<StdioStream>;
  options?: RemoteUploadOptions;
}): Promise<void> {
  const { localPath, resolvedRemotePath, exec, options } = params;

  let totalBytes: number | undefined;
  if (options) {
    totalBytes = await stat(localPath).then((value) => value.size);
    if (options.signal?.aborted) {
      const error = new Error("Remote upload canceled");
      error.name = "AbortError";
      throw error;
    }
  }

  const parentDir = posix.dirname(resolvedRemotePath);
  const command = `mkdir -p ${quotePosixShellArg(parentDir)} && cat > ${quotePosixShellArg(resolvedRemotePath)}`;
  const stream = await exec(command);

  if (!options) {
    await new Promise<void>((resolve, reject) => {
      const readStream = createReadStream(localPath);
      const stdin = stream.stdin;
      let settled = false;

      const finishWithError = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        readStream.destroy();
        const destroyableStdin = stdin as NodeJS.WritableStream & {
          destroy?: (reason?: Error) => void;
        };
        if (typeof destroyableStdin.destroy === "function") {
          destroyableStdin.destroy(error);
        } else {
          stdin.end();
        }
        reject(error);
      };

      readStream.on("error", (error) => finishWithError(error));
      stdin.on("error", (error: Error) => finishWithError(error));
      readStream.pipe(stdin);
      stream.onClose((code) => {
        if (settled) {
          return;
        }
        settled = true;
        if (code !== 0) {
          reject(new Error(`WSL upload failed with exit code ${code}`));
          return;
        }
        resolve();
      });
    });
    return;
  }

  const progressOptions = options;
  await new Promise<void>((resolve, reject) => {
    const readStream = createReadStream(localPath);
    const stdin = stream.stdin;
    let uploadedBytes = 0;
    let settled = false;
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      progressOptions.signal?.removeEventListener("abort", abort);
      readStream.destroy();
      const destroyable = stdin as NodeJS.WritableStream & {
        destroy?: (reason?: Error) => void;
      };
      destroyable.destroy?.(error);
      reject(error);
    };
    const abort = () => {
      const error = new Error("Remote upload canceled");
      error.name = "AbortError";
      finishError(error);
    };
    progressOptions.signal?.addEventListener("abort", abort, { once: true });
    readStream.on("data", (chunk: Buffer) => {
      uploadedBytes += chunk.length;
      progressOptions.onProgress?.({ uploadedBytes, totalBytes: totalBytes as number });
    });
    readStream.on("error", finishError);
    stdin.on("error", finishError);
    stream.onClose((code) => {
      if (settled) return;
      settled = true;
      progressOptions.signal?.removeEventListener("abort", abort);
      if (code !== 0) {
        reject(new Error(`WSL upload failed with exit code ${code}`));
        return;
      }
      progressOptions.onProgress?.({ uploadedBytes: totalBytes as number, totalBytes: totalBytes as number });
      resolve();
    });
    readStream.pipe(stdin);
  });
}
