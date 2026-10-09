/**
 * Dynamic Workflow run 读模型公开契约。
 *
 * 该入口只暴露派生查询与能力窄化；journal 生命周期、run owner 和持久化实现仍由宿主拥有。
 */
export { resolveDynamicWorkflowRunLabel } from "./domain/label.js";
export { lineageFields, supersededByOf } from "./domain/lineage.js";
export { runLineageActiveMs } from "./app/elapsed.js";
export {
  isDynamicWorkflowTaskLinkStore,
  resolveDynamicWorkflowJournalStore,
  supportsNonTerminalRunQuery,
  supportsRunEnumeration,
  supportsRunLifeSpans,
  supportsRunIntrospection,
} from "./app/journal.js";
export type {
  DynamicWorkflowIntrospectableJournal,
  DynamicWorkflowTaskLinkStore,
} from "./app/journal.js";
export { artifactsOf } from "./app/artifact-projection.js";
export {
  artifactRowId,
  listArtifactItemsFrom,
  supportsArtifactReads,
} from "./app/artifact-queries.js";
export { readWorkflowArtifactBytes } from "./app/artifact-read.js";
export { listWorkspaceNodesFrom, readWorkspaceNodeResultFrom } from "./app/workspace.js";
