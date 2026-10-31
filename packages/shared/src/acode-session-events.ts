// session 事件流 wire 类型（事件信封 / discriminated union / result）。M4 从 legacy barrel 中立迁移，形状不变。

import { z } from "zod";
import { acodeMessagePartDeltaEventPayloadSchema, acodeMessagePartRemovedEventPayloadSchema, acodeMessagePartUpsertedEventPayloadSchema, acodeMessageRemovedEventPayloadSchema, acodeMessageUpsertedEventPayloadSchema, acodeModelStreamingEventPayloadSchema, acodePermissionRequestedEventPayloadSchema, acodePermissionResolvedEventPayloadSchema, acodeSessionClosedEventPayloadSchema, acodeSessionCreatedEventPayloadSchema, acodeSessionResumedEventPayloadSchema, acodeSessionTitleUpdatedEventPayloadSchema, acodeToolUpdatedEventPayloadSchema, acodeTurnCompletedEventPayloadSchema, acodeTurnFailedEventPayloadSchema, acodeTurnStartedEventPayloadSchema, acodeTurnSteerDrainedEventPayloadSchema, acodeTurnSteerQueuedEventPayloadSchema, acodeUserInputRequestedEventPayloadSchema, acodeUserInputResolvedEventPayloadSchema } from "./acode-session-event-payloads.js";
import { acodeSessionStateSnapshotSchema } from "./acode-session-projection.js";
import { acodeDeliveryKindSchema, acodeWorkspaceRefSchema } from "./acode-session-types.js";

const nonEmptyString = z.string().trim().min(1);
const timestampMsSchema = z.number().int().nonnegative();
const jsonObjectSchema = z.record(z.string(), z.unknown());

export const acodeEventEnvelopeSchema = z
  .object({
    eventId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    seq: z.number().int().nonnegative(),
    traceId: nonEmptyString.optional(),
    timestamp: timestampMsSchema,
    deliveryKind: acodeDeliveryKindSchema.optional(),
  })
  .strict();

export const acodeSessionEventTypeSchema = z.enum([
  "session.created",
  "session.resumed",
  "session.updated",
  "session.titleUpdated",
  "session.closed",
  "turn.started",
  "turn.steerQueued",
  "turn.steerDrained",
  "turn.completed",
  "turn.failed",
  "message.upserted",
  "message.removed",
  "part.started",
  "part.delta",
  "part.upserted",
  "part.removed",
  "model.streaming",
  "tool.updated",
  "permission.requested",
  "permission.resolved",
  "userInput.requested",
  "userInput.resolved",
  "checkpoint.created",
  "rewind.triggered",
  "streamRecovery.updated",
]);

export type ACodeSessionEventType = z.infer<typeof acodeSessionEventTypeSchema>;

function acodeSessionEventEnvelopeFor<T extends ACodeSessionEventType>(
  type: T,
  payload: z.ZodTypeAny,
) {
  return acodeEventEnvelopeSchema.extend({
    type: z.literal(type),
    payload: payload.optional(),
  });
}

export const acodeSessionEventSchema = z.discriminatedUnion("type", [
  acodeSessionEventEnvelopeFor("session.created", acodeSessionCreatedEventPayloadSchema),
  acodeSessionEventEnvelopeFor("session.resumed", acodeSessionResumedEventPayloadSchema),
  acodeSessionEventEnvelopeFor("session.updated", jsonObjectSchema),
  acodeSessionEventEnvelopeFor("session.titleUpdated", acodeSessionTitleUpdatedEventPayloadSchema),
  acodeSessionEventEnvelopeFor("session.closed", acodeSessionClosedEventPayloadSchema),
  acodeSessionEventEnvelopeFor("turn.started", acodeTurnStartedEventPayloadSchema),
  acodeSessionEventEnvelopeFor("turn.steerQueued", acodeTurnSteerQueuedEventPayloadSchema),
  acodeSessionEventEnvelopeFor("turn.steerDrained", acodeTurnSteerDrainedEventPayloadSchema),
  acodeSessionEventEnvelopeFor("turn.completed", acodeTurnCompletedEventPayloadSchema),
  acodeSessionEventEnvelopeFor("turn.failed", acodeTurnFailedEventPayloadSchema),
  acodeSessionEventEnvelopeFor("message.upserted", acodeMessageUpsertedEventPayloadSchema),
  acodeSessionEventEnvelopeFor("message.removed", acodeMessageRemovedEventPayloadSchema),
  acodeSessionEventEnvelopeFor("part.started", acodeMessagePartUpsertedEventPayloadSchema),
  acodeSessionEventEnvelopeFor("part.delta", acodeMessagePartDeltaEventPayloadSchema),
  acodeSessionEventEnvelopeFor("part.upserted", acodeMessagePartUpsertedEventPayloadSchema),
  acodeSessionEventEnvelopeFor("part.removed", acodeMessagePartRemovedEventPayloadSchema),
  acodeSessionEventEnvelopeFor("model.streaming", acodeModelStreamingEventPayloadSchema),
  acodeSessionEventEnvelopeFor("tool.updated", acodeToolUpdatedEventPayloadSchema),
  acodeSessionEventEnvelopeFor("permission.requested", acodePermissionRequestedEventPayloadSchema),
  acodeSessionEventEnvelopeFor("permission.resolved", acodePermissionResolvedEventPayloadSchema),
  acodeSessionEventEnvelopeFor("userInput.requested", acodeUserInputRequestedEventPayloadSchema),
  acodeSessionEventEnvelopeFor("userInput.resolved", acodeUserInputResolvedEventPayloadSchema),
  acodeSessionEventEnvelopeFor("checkpoint.created", jsonObjectSchema),
  acodeSessionEventEnvelopeFor("rewind.triggered", jsonObjectSchema),
  acodeSessionEventEnvelopeFor("streamRecovery.updated", jsonObjectSchema),
]);

export type ACodeSessionEvent = z.infer<typeof acodeSessionEventSchema>;

export const acodeSessionEventsResultSchema = z
  .object({
    events: z.array(acodeSessionEventSchema),
  })
  .strict();

export const acodeStateUpdatedNotificationSchema = z
  .object({
    type: z.literal("state.updated"),
    scope: z.enum(["server", "workspace", "session"]),
    workspace: acodeWorkspaceRefSchema.optional(),
    sessionId: nonEmptyString.optional(),
    revision: z.number().int().nonnegative(),
    reason: z.string().optional(),
    patch: z.unknown(),
  })
  .strict();

export type ACodeStateUpdatedNotification = z.infer<typeof acodeStateUpdatedNotificationSchema>;

export const acodeSessionSubscribeResultSchema = z
  .object({
    sessionId: nonEmptyString,
    eventSeq: z.number().int().nonnegative(),
    events: z.array(acodeSessionEventSchema),
    snapshot: acodeSessionStateSnapshotSchema.optional(),
  })
  .strict();
