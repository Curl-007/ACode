// ACode 协议版本无关 JSON-RPC wire 信封（请求/通知/响应/错误）。M4 裁决 E：这是 legacy 与 v4 共用的永久载体面，不是 legacy 债务。v4 原生信封建模归 M4b。

import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

export const ACODE_PROTOCOL_NAME = "ACode Protocol" as const;

export const ACODE_PROTOCOL_VERSION = 1 as const;

export const acodeProtocolErrorCodes = {
  sessionUnavailable: -32004,
} as const;

export const acodeProtocolRequestIdSchema = z.union([z.string(), z.number().int()]);

export type ACodeProtocolRequestId = z.infer<typeof acodeProtocolRequestIdSchema>;

export const acodeProtocolTraceSchema = z
  .object({
    traceparent: nonEmptyString.optional(),
    traceId: nonEmptyString.optional(),
    parentId: nonEmptyString.optional(),
    spanId: nonEmptyString.optional(),
  })
  .strict();

export type ACodeProtocolTrace = z.infer<typeof acodeProtocolTraceSchema>;

export const acodeProtocolRequestSchema = z
  .object({
    id: acodeProtocolRequestIdSchema,
    method: nonEmptyString,
    params: z.unknown().optional(),
    trace: acodeProtocolTraceSchema.optional(),
  })
  .strict();

export type ACodeProtocolRequest = z.infer<typeof acodeProtocolRequestSchema>;

export const acodeProtocolNotificationSchema = z
  .object({
    method: nonEmptyString,
    params: z.unknown().optional(),
    trace: acodeProtocolTraceSchema.optional(),
  })
  .strict();

export type ACodeProtocolNotification = z.infer<typeof acodeProtocolNotificationSchema>;

export const acodeProtocolResponseSchema = z
  .object({
    id: acodeProtocolRequestIdSchema,
    result: z.unknown(),
  })
  .strict();

export type ACodeProtocolResponse = z.infer<typeof acodeProtocolResponseSchema>;

export const acodeProtocolErrorSchema = z
  .object({
    id: acodeProtocolRequestIdSchema,
    error: z
      .object({
        code: z.number().int(),
        message: nonEmptyString,
        data: z.unknown().optional(),
      })
      .strict(),
  })
  .strict();

export type ACodeProtocolError = z.infer<typeof acodeProtocolErrorSchema>;

export const acodeProtocolMessageSchema = z.union([
  acodeProtocolRequestSchema,
  acodeProtocolNotificationSchema,
  acodeProtocolResponseSchema,
  acodeProtocolErrorSchema,
]);

export type ACodeProtocolMessage = z.infer<typeof acodeProtocolMessageSchema>;

export const acodeProtocolEmptyResultSchema = z.object({}).strict();
