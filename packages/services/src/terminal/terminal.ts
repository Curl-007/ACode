import type { Event } from "@acode/rpc";
import { ServiceChannels } from "@acode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { TerminalFontFamilySource, TerminalThemeProfile } from "./terminalProfile.js";

export interface TerminalWindowsPtyInfo {
  backend: "conpty" | "winpty";
  buildNumber?: number;
}

export interface ITerminalService {
  create(params: { cols: number; rows: number; cwd?: string }): Promise<{
    id: string;
    shell: string;
    fontFamily: string;
    fontSize?: number;
    theme?: TerminalThemeProfile;
    fontFamilySource: TerminalFontFamilySource;
    windowsPty?: TerminalWindowsPtyInfo;
  }>;
  write(params: { id: string; data: string }): Promise<void>;
  resize(params: { id: string; cols: number; rows: number }): Promise<void>;
  dispose(params: { id: string }): Promise<void>;
  onDynamicData(id: string): Event<string>;
  onDynamicExit(id: string): Event<number>;
}

export const ITerminalService = createServiceDescriptor<ITerminalService>(
  ServiceChannels.Terminal,
  {
    allowedMethods: ["create", "write", "resize", "dispose", "onDynamicData", "onDynamicExit"],
    argumentValidators: {
      create: (args) => {
        const value = args[0];
        if (
          args.length !== 1 ||
          !value ||
          typeof value !== "object" ||
          typeof (value as { cols?: unknown }).cols !== "number" ||
          typeof (value as { rows?: unknown }).rows !== "number"
        ) {
          throw new Error("expected terminal dimensions");
        }
      },
      write: (args) => {
        const value = args[0];
        if (
          args.length !== 1 ||
          !value ||
          typeof value !== "object" ||
          typeof (value as { id?: unknown }).id !== "string" ||
          typeof (value as { data?: unknown }).data !== "string"
        ) {
          throw new Error("expected terminal id and data");
        }
      },
      resize: (args) => {
        const value = args[0];
        if (
          args.length !== 1 ||
          !value ||
          typeof value !== "object" ||
          typeof (value as { id?: unknown }).id !== "string" ||
          typeof (value as { cols?: unknown }).cols !== "number" ||
          typeof (value as { rows?: unknown }).rows !== "number"
        ) {
          throw new Error("expected terminal id and dimensions");
        }
      },
      dispose: (args) => {
        const value = args[0];
        if (
          args.length !== 1 ||
          !value ||
          typeof value !== "object" ||
          typeof (value as { id?: unknown }).id !== "string"
        ) {
          throw new Error("expected terminal id");
        }
      },
      onDynamicData: (args) => {
        if (args.length !== 1 || typeof args[0] !== "string") {
          throw new Error("expected terminal id");
        }
      },
      onDynamicExit: (args) => {
        if (args.length !== 1 || typeof args[0] !== "string") {
          throw new Error("expected terminal id");
        }
      },
    },
  },
);
