// 拆分依据：ssh-backend.ts 超 400 行架构上限。SSH 上传双通道（SFTP + exec pipe 回退）的传输实现、
// 失败分类标记与取消语义是独立的传输层；原私有方法 uploadViaSftp/uploadViaExec/错误标记函数下沉为
// 叶子函数，通过最小接口参数（client、exec、assertNotDisposed）接入 SSHBackend，行为逐点等价。
import { createReadStream } from "node:fs";
import { posix } from "node:path";
import type { Client as SSHClient } from "ssh2";
import type { RemoteUploadOptions, StdioStream } from "@acode/server/remote/backend.js";
import { quotePosixShellArg } from "@acode/server/remote/posixShell.js";
import {
  createSSHUploadProgressReporter,
  formatSSHUploadError,
  formatSSHUploadLabel,
  readLocalFileSize,
} from "@acode/server/remote/sshUploadProgress.js";

export type SSHUploadFailureKind = "sftp-session" | "sftp-write" | "local-read" | "aborted";

export type SSHUploadFailure = Error & {
  uploadFailureKind?: SSHUploadFailureKind;
};

export function normalizeUnknownSSHUploadError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === "string" && error.length > 0) {
    return new Error(error);
  }

  return new Error(fallbackMessage);
}

export function markSSHUploadFailure(
  error: unknown,
  kind: SSHUploadFailureKind,
  fallbackMessage: string,
): SSHUploadFailure {
  const normalizedError = normalizeUnknownSSHUploadError(error, fallbackMessage) as SSHUploadFailure;
  normalizedError.uploadFailureKind = kind;
  return normalizedError;
}

export function createSSHUploadAbortError(): Error {
  const error = new Error("Remote upload canceled");
  error.name = "AbortError";
  return error;
}

export function throwIfSSHUploadAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createSSHUploadAbortError();
}

export function shouldFallbackToSSHExecUpload(error: unknown): boolean {
  const uploadFailureKind = (error as SSHUploadFailure | undefined)?.uploadFailureKind;
  return uploadFailureKind === "sftp-session" || uploadFailureKind === "sftp-write";
}

export function describeSSHUploadFailure(error: unknown): string {
  const uploadFailureKind = (error as SSHUploadFailure | undefined)?.uploadFailureKind;
  const errorLabel = formatSSHUploadError(error);
  return uploadFailureKind ? `${uploadFailureKind} failure (${errorLabel})` : errorLabel;
}

export interface SSHUploadPort {
  client: SSHClient;
  exec: (command: string) => Promise<StdioStream>;
  assertNotDisposed: () => void;
}

export async function uploadViaSftp(
  port: SSHUploadPort,
  localPath: string,
  resolvedRemotePath: string,
  options?: RemoteUploadOptions,
): Promise<void> {
  const { client, assertNotDisposed } = port;
  throwIfSSHUploadAborted(options?.signal);
  assertNotDisposed();
  const uploadLabel = formatSSHUploadLabel(resolvedRemotePath);
  const totalBytes = await readLocalFileSize(localPath);
  const progressReporter = createSSHUploadProgressReporter("sftp", uploadLabel, totalBytes);
  const reportProgress = (uploadedBytes: number, force: boolean) => {
    progressReporter(uploadedBytes, force);
    options?.onProgress?.({ uploadedBytes, totalBytes: totalBytes ?? 0 });
  };

  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) {
        // session/write 失败会由 upload() 统一降级并记录一次 warn；这里若先记 error，
        // 同一个可恢复事件会同时出现 error + warn，误导为部署失败。
        reject(markSSHUploadFailure(err, "sftp-session", "Failed to open SFTP session"));
        return;
      }
      console.log(
        `[ssh] upload: started via sftp for ${uploadLabel} (${localPath} -> ${resolvedRemotePath})`,
      );

      const readStream = createReadStream(localPath);
      const writeStream = sftp.createWriteStream(resolvedRemotePath);
      let transferredBytes = 0;
      let settled = false;
      let suppressFollowupStreamErrors = false;

      const resolveOnce = () => {
        if (settled) {
          return;
        }
        settled = true;
        options?.signal?.removeEventListener("abort", abortOnce);
        reportProgress(transferredBytes, true);
        console.log(`[ssh] upload: completed via sftp for ${uploadLabel}`);
        sftp.end();
        resolve();
      };

      const rejectOnce = (error: unknown, kind: SSHUploadFailureKind, message: string) => {
        if (settled) {
          return;
        }
        settled = true;
        options?.signal?.removeEventListener("abort", abortOnce);
        suppressFollowupStreamErrors = true;
        // SFTP 失败后如果不立刻停掉本地 read stream，它仍会继续把文件读到 100%，
        // UI 就会在已经切到 exec pipe 之后还刷出一串虚假的 `[sftp] upload progress`。
        // 这里在失败瞬间主动停掉两端 stream，保证第一种上传方式的进度日志立即停止。
        // 注意不要把原始 error 再次喂给 destroy，否则清理路径本身会再冒出一轮重复 error 日志。
        readStream.unpipe(writeStream);
        readStream.destroy();
        const destroyableWriteStream = writeStream as NodeJS.WritableStream & {
          destroy?: (error?: Error) => void;
        };
        if (typeof destroyableWriteStream.destroy === "function") {
          destroyableWriteStream.destroy();
        }
        sftp.end();
        reject(markSSHUploadFailure(error, kind, message));
      };

      const abortOnce = () => {
        rejectOnce(createSSHUploadAbortError(), "aborted", "Remote upload canceled");
      };
      if (options?.signal?.aborted) {
        abortOnce();
        return;
      }
      options?.signal?.addEventListener("abort", abortOnce, { once: true });

      readStream.on("data", (chunk: Buffer) => {
        if (settled) {
          return;
        }
        transferredBytes += chunk.length;
        reportProgress(transferredBytes, false);
      });
      writeStream.on("close", resolveOnce);
      writeStream.on("error", (error: Error) => {
        if (settled || suppressFollowupStreamErrors) {
          return;
        }
        rejectOnce(error, "sftp-write", `Failed to write ${resolvedRemotePath} over SFTP`);
      });
      readStream.on("error", (error: Error) => {
        if (settled || suppressFollowupStreamErrors) {
          return;
        }
        console.error(
          `[ssh] upload: local read failed for ${uploadLabel}: ${formatSSHUploadError(error)}`,
        );
        rejectOnce(error, "local-read", `Failed to read local file ${localPath}`);
      });
      readStream.pipe(writeStream);
    });
  });
}

export async function uploadViaExec(
  port: SSHUploadPort,
  localPath: string,
  resolvedRemotePath: string,
  options?: RemoteUploadOptions,
): Promise<void> {
  const { exec } = port;
  const uploadLabel = formatSSHUploadLabel(resolvedRemotePath);
  const totalBytes = await readLocalFileSize(localPath);
  const progressReporter = createSSHUploadProgressReporter("exec", uploadLabel, totalBytes);
  const reportProgress = (uploadedBytes: number, force: boolean) => {
    progressReporter(uploadedBytes, force);
    options?.onProgress?.({ uploadedBytes, totalBytes: totalBytes ?? 0 });
  };
  throwIfSSHUploadAborted(options?.signal);
  const parentDir = posix.dirname(resolvedRemotePath);
  const command = `mkdir -p ${quotePosixShellArg(parentDir)} && cat > ${quotePosixShellArg(resolvedRemotePath)}`;
  console.log(
    `[ssh] upload: started via exec pipe for ${uploadLabel} (${localPath} -> ${resolvedRemotePath})`,
  );
  const stream = await exec(command);

  await new Promise<void>((resolve, reject) => {
    const readStream = createReadStream(localPath);
    const stdin = stream.stdin;
    let transferredBytes = 0;
    let settled = false;

    const finishWithError = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      options?.signal?.removeEventListener("abort", abortOnce);
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

    const abortOnce = () => finishWithError(createSSHUploadAbortError());
    if (options?.signal?.aborted) {
      abortOnce();
      return;
    }
    options?.signal?.addEventListener("abort", abortOnce, { once: true });

    readStream.on("error", (error) => finishWithError(error));
    readStream.on("data", (chunk: Buffer) => {
      transferredBytes += chunk.length;
      reportProgress(transferredBytes, false);
    });
    stdin.on("error", (error: Error) => finishWithError(error));
    readStream.pipe(stdin);
    stream.onClose((code) => {
      if (settled) {
        return;
      }
      settled = true;
      options?.signal?.removeEventListener("abort", abortOnce);
      reportProgress(transferredBytes, true);
      if (code !== 0) {
        console.error(`[ssh] upload: exec pipe failed for ${uploadLabel}: exit code ${code}`);
        reject(new Error(`SSH exec upload failed with exit code ${code}`));
        return;
      }
      console.log(`[ssh] upload: completed via exec pipe for ${uploadLabel}`);
      resolve();
    });
  });
}
