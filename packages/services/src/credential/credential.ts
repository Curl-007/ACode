import { ServiceChannels } from "@acode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 凭据管理服务
 *
 * 提供 key-value 形式的凭据读写。
 * 实现端（host process）负责加密存储细节，
 * 消费端（renderer）只通过 RPC 调用，不感知存储位置。
 */
export interface ICredentialService {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export const ICredentialService = createServiceDescriptor<ICredentialService>(
  ServiceChannels.Credential,
  {
    allowedMethods: ["load", "save", "delete"],
    argumentValidators: {
      load: (args) => {
        if (args.length !== 1 || typeof args[0] !== "string" || args[0].length === 0) {
          throw new Error("expected one non-empty key");
        }
      },
      save: (args) => {
        if (
          args.length !== 2 ||
          typeof args[0] !== "string" ||
          args[0].length === 0 ||
          typeof args[1] !== "string"
        ) {
          throw new Error("expected key and value strings");
        }
      },
      delete: (args) => {
        if (args.length !== 1 || typeof args[0] !== "string" || args[0].length === 0) {
          throw new Error("expected one non-empty key");
        }
      },
    },
  },
);
