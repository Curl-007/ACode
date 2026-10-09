import { getMediaPreviewFormat, ServiceChannels, type MediaPreviewKind } from "@acode/shared";
import type { IFileService } from "../file/file.js";
import { createServiceDescriptor } from "../descriptors.js";

export type MediaPreviewPreparation =
  | {
      kind: "local-url";
      mediaType: string;
      path: string;
      size: number;
      url: string;
    }
  | {
      kind: "host-range-url";
      mediaType: string;
      path: string;
      previewId: string;
      size: number;
      url: string;
      urlExpiresAt: number;
    }
  | {
      kind: "inline";
      dataBase64: string;
      mediaType: string;
      path: string;
      size: number;
    };

export interface IMediaPreviewService {
  prepare(params: {
    path: string;
    expectedKind: MediaPreviewKind;
  }): Promise<MediaPreviewPreparation>;
  refreshPlaybackUrl?(params: { previewId: string }): Promise<{
    url: string;
    expiresAt: number;
  }>;
  release?(params: { previewId: string }): Promise<void>;
}

export const IMediaPreviewService = createServiceDescriptor<IMediaPreviewService>(
  ServiceChannels.MediaPreview,
  {
    allowedMethods: ["prepare", "refreshPlaybackUrl", "release"],
    argumentValidators: {
      prepare: (args) => {
        const params = requireParams(args);
        requireString(params.path, "path");
        // expectedKind 为封闭枚举（"audio" | "video"），成员由服务实现校验。
        requireString(params.expectedKind, "expectedKind");
      },
      refreshPlaybackUrl: (args) => {
        const params = requireParams(args);
        requireNonEmptyString(params.previewId, "previewId");
      },
      release: (args) => {
        const params = requireParams(args);
        requireNonEmptyString(params.previewId, "previewId");
      },
    },
  },
);

// —— 文件内私有 RPC 参数校验辅助（边界迁移规则禁止跨文件共享 helper，先例 file.ts）——

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 恰好一个参数且必须是非 null、非数组对象。 */
function requireParams(args: readonly unknown[]): Record<string, unknown> {
  if (args.length !== 1) throw new Error("expected one params object");
  const value = args[0];
  if (!isRecord(value)) throw new Error("expected one params object");
  return value;
}

function requireString(value: unknown, field: string): void {
  if (typeof value !== "string") throw new Error(`invalid ${field}`);
}

function requireNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
}

export function createMediaPreviewService(options: {
  fileService: IFileService;
  authorizeLocalMediaPreviewPath?: (path: string) => Promise<string>;
  createLocalMediaPreviewUrl?: (path: string) => string;
  inlineMaxBytes?: number;
}): IMediaPreviewService {
  const inlineMaxBytes = options.inlineMaxBytes ?? 8 * 1024 * 1024;

  return {
    async prepare({ path, expectedKind }) {
      const format = getMediaPreviewFormat(path);
      if (!format || format.kind !== expectedKind) {
        throw new Error(`Unsupported media preview format: ${path}`);
      }

      const fileStat = await options.fileService.stat({ path });
      if (fileStat.type !== "file" || typeof fileStat.size !== "number") {
        throw new Error(`Path is not a media file: ${path}`);
      }

      if (options.authorizeLocalMediaPreviewPath && options.createLocalMediaPreviewUrl) {
        const canonicalPath = await options.authorizeLocalMediaPreviewPath(path);
        return {
          kind: "local-url",
          mediaType: format.mediaType,
          path: canonicalPath,
          size: fileStat.size,
          url: options.createLocalMediaPreviewUrl(canonicalPath),
        };
      }

      if (fileStat.size > inlineMaxBytes) {
        throw new Error(`Media file is too large for inline preview: ${path}`);
      }

      const preview = await options.fileService.readMediaPreview({
        path,
        maxBytes: inlineMaxBytes,
      });
      return {
        kind: "inline",
        dataBase64: preview.dataBase64,
        mediaType: preview.mediaType,
        path,
        size: preview.totalBytes,
      };
    },
  };
}
