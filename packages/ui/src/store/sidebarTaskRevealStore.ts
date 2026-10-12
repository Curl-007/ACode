import { create } from "zustand";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

export interface SidebarTaskRevealRequest {
  requestId: number;
  workspacePath: string;
  workspaceKey: string;
  taskId: string;
}

interface SidebarTaskRevealState {
  pendingRequest: SidebarTaskRevealRequest | null;
  requestReveal: (target: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }) => void;
  consumeRequest: (requestId: number) => void;
}

let requestSequence = 0;

export const useSidebarTaskRevealStore = create<SidebarTaskRevealState>((set) => ({
  pendingRequest: null,
  requestReveal: (target) => {
    set({
      pendingRequest: {
        requestId: ++requestSequence,
        workspacePath: target.workspacePath,
        workspaceKey: buildTaskWorkspaceKey(target.workspacePath, target.workspaceIdentity),
        taskId: target.taskId,
      },
    });
  },
  consumeRequest: (requestId) => {
    set((state) =>
      state.pendingRequest?.requestId === requestId ? { pendingRequest: null } : state,
    );
  },
}));
