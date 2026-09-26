/**
 * ACode Agent Slash Commands 便捷 hook
 *
 * 返回当前 workspace 下 Agent 广播的可用 slash commands 列表。
 */
import { useACodeSessionStore, selectWorkspaceACodeState } from "../store/acodeSessionStore.js";

export function useSlashCommands(workspacePath: string, workspaceIdentity?: string) {
  return useACodeSessionStore(
    (state) => selectWorkspaceACodeState(state, workspacePath, workspaceIdentity).slashCommands,
  );
}
