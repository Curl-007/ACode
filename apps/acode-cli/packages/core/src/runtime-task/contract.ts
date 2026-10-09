/** runtime-task 单一公开入口；Registry 方法语义见 CONTRACT.md。 */
import type { RuntimeTaskPendingMessage, RuntimeTaskSnapshot } from "./types.js";
export type * from "./types.js";
export {
  InMemoryRuntimeTaskRegistry,
  isTerminalRuntimeTask,
  hasRunningBackgroundRuntimeTask,
} from "./registry.js";
export { formatTaskNotification } from "./notification.js";
export { escapeXml, truncateTaskNotification } from "./notification-primitives.js";
export { shouldSuppressSealedSubagentBashNotification } from "./notification-policy.js";
export {
  formatWorkflowEscalationNotification,
  formatWorkflowProviderStopError,
  formatWorkflowStallNotification,
  type WorkflowEscalationNotificationInput,
  type WorkflowStallNotificationInput,
} from "./workflow-notification-copy.js";

export interface RuntimeTaskRegistry {
  all(): Record<string, RuntimeTaskSnapshot>;
  get(id: string): RuntimeTaskSnapshot | undefined;
  drainMessages(id: string): RuntimeTaskPendingMessage[];
  queueMessage(id: string, message: RuntimeTaskPendingMessage): RuntimeTaskSnapshot | undefined;
  register(task: RuntimeTaskSnapshot): void;
  remove(id: string): void;
  requestBackground(id: string): boolean;
  setActiveBranchGeneration?(generation: number): void;
  update(
    id: string,
    patcher: (task: RuntimeTaskSnapshot) => RuntimeTaskSnapshot,
  ): RuntimeTaskSnapshot | undefined;
  waitForBackgroundRequest(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined>;
  waitForTerminal(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined>;
}
