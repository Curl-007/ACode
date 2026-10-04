// ============================================================
// Open tool - open a file/directory/URL for the user (K9)
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const OPEN_TOOL_NAME = "Open";

export const OPEN_PROVIDER_DESCRIPTION = `Opens a file, directory, or URL in the user's environment (default app / file manager / browser) so the user can see it.
- Use it to surface finished artifacts to the user: open a built report, the logs directory, or a preview URL. Fire-and-forget: returns immediately after the platform opens it.
- URLs must be http(s); other schemes are rejected. Paths go through the platform service (reveal locates the file in the file manager without opening it).
- Opening anything outside the workspace or opening a URL asks for confirmation.`;

export const OpenInputSchema = z
  .object({
    target: z
      .string()
      .trim()
      .min(1)
      .max(2_048)
      .describe("http(s) URL, or a file/directory path (absolute or workspace-relative)."),
    action: z
      .enum(["open", "reveal"])
      .optional()
      .describe("open (default) opens it with the default app; reveal only locates it in the file manager."),
  })
  .strict();

export type OpenInput = z.infer<typeof OpenInputSchema>;

export const OpenInputJsonSchema = {
  ...toToolJsonSchema(OpenInputSchema),
  required: ["target"],
};

export const OpenResultSchema = z
  .object({
    opened: z.boolean(),
    kind: z.enum(["url", "file", "directory"]),
    detail: z
      .string()
      .optional()
      .describe("Human-readable failure reason when opened=false (e.g. platform capability missing)."),
  })
  .strict();

export type OpenResult = z.infer<typeof OpenResultSchema>;

export const OpenResultJsonSchema = toToolJsonSchema(OpenResultSchema);
