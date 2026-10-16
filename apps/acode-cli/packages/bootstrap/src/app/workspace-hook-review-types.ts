import {
  SessionEventType,
  type WorkspaceHookBundleSnapshot,
  type WorkspaceHookReasonCode,
  type WorkspaceHookTrustRecord,
  type Logger,
  type WorkspaceHookAdmissionUpdatedPayload,
} from "@acode/contracts";
import type { WorkspaceHookRuntimeAdmissionPort, WorkspaceHookTrustCoordinator } from "@acode/core";
import type { WorkspaceHookReviewRequestPayload } from "@acode/shared/acode-protocol-v4";
import type { WorkspaceHookReviewPinsPort } from "./workspace-hook-review-pins.js";

export type WorkspaceHookReviewLifecycleEvent =
  | {
      type: typeof SessionEventType.WorkspaceHookReviewRequested;
      payload: { request: WorkspaceHookReviewRequestPayload };
    }
  | {
      type: typeof SessionEventType.WorkspaceHookReviewSettled;
      payload: {
        interactionId: string;
        state: "resolved" | "timed_out" | "configuration_error";
        reasonCode?: string;
      };
    }
  | {
      type: typeof SessionEventType.WorkspaceHookReviewSuperseded;
      payload: { interactionId: string; supersededByInteractionId: string };
    }
  | {
      type: typeof SessionEventType.WorkspaceHookAdmissionUpdated;
      payload: WorkspaceHookAdmissionUpdatedPayload;
    };

export interface WorkspaceHookReviewHostPort {
  taskId: string;
  runId: string;
  workspaceLabel: string;
  remoteSessionId?: string;
  emit(event: WorkspaceHookReviewLifecycleEvent): Promise<void>;
}

export interface WorkspaceHookReviewMutationPort {
  toggle(
    input: {
      snapshot: WorkspaceHookBundleSnapshot;
      reviewItemId: string;
      enabled: boolean;
    },
    onWriteCommitted: () => void | Promise<void>,
  ): Promise<WorkspaceHookBundleSnapshot>;
}

export interface WorkspaceHookTrustStoreMutationPort {
  grant(
    records: readonly WorkspaceHookTrustRecord[],
  ): Promise<{ records: WorkspaceHookTrustRecord[] }>;
  revoke(input: {
    workspaceIdentity: string;
    hookDeclarationDigests?: readonly string[];
  }): Promise<{ records: WorkspaceHookTrustRecord[] }>;
}

export type WorkspaceHookReviewCommandResult =
  | { accepted: true; reviewItemIds: string[] }
  | { accepted: false; reasonCode: WorkspaceHookReasonCode };

export interface WorkspaceHookReviewControllerOptions {
  admission: WorkspaceHookRuntimeAdmissionPort;
  appVersion?: string;
  coordinator: WorkspaceHookTrustCoordinator;
  host: WorkspaceHookReviewHostPort;
  logger?: Logger;
  mutation: WorkspaceHookReviewMutationPort;
  /**
   * hook-pins 三态钉扎端口（specs/plugin-hook-middleware.md 三 / 接线 W3）。缺席 =
   * pins 面未接线：授予照旧生效，只是不落内容级钉扎（波前形态，零破坏）。
   */
  pins?: WorkspaceHookReviewPinsPort;
  sessionId: string;
  store: Promise<WorkspaceHookTrustStoreMutationPort>;
  now?: () => number;
  createId?: () => string;
}
