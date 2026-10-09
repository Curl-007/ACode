import type { ArtifactContentOp } from "../facade/registry.js";
import type { EngineState } from "./engine-state.js";
import type {
  ArtifactPublishRequest,
  ArtifactRef,
  ArtifactVersionRecord,
  InstanceRef,
} from "./types.js";
import { refToString, WorkflowError } from "./types.js";

export interface ArtifactPublishHelpers {
  admitArtifact(
    state: EngineState,
    id: string,
    op: ArtifactContentOp,
    primary: boolean,
  ): WorkflowError | undefined;
  settleArtifactFailure(
    state: EngineState,
    instance: InstanceRef,
    hash: string,
    issued: { id: string; op: ArtifactContentOp },
    error: WorkflowError,
  ): WorkflowError;
  settleArtifactPublish(
    state: EngineState,
    instance: InstanceRef,
    hash: string,
    issued: { id: string; op: ArtifactContentOp; version: number; primary: boolean },
    record: ArtifactVersionRecord,
  ): ArtifactRef;
}

/** 前一个同 id 发布完成后执行一次真实准入与 store 往返。 */
export function publishFreshArtifact(
  state: EngineState,
  siteId: string,
  op: ArtifactContentOp,
  args: unknown[],
  instance: InstanceRef,
  id: string,
  payload: string,
  primaryOption: unknown,
  hash: string,
  helpers: ArtifactPublishHelpers,
): Promise<ArtifactRef> {
  if (state.isRunSettled()) return Promise.reject(state.runError());
  // 粘着：这个 id 已经是 primary，则这一版也是，不管本次有没有再写 `primary`。
  const idState = state.artifacts.get(id);
  const primary = primaryOption === true || idState?.primary === true;
  const admission = helpers.admitArtifact(state, id, op, primary);
  if (admission !== undefined) {
    return Promise.reject(
      helpers.settleArtifactFailure(state, instance, hash, { id, op }, admission),
    );
  }

  const version = (idState?.versions ?? 0) + 1;
  const publish = state.driver.executeArtifactPublish;
  if (publish === undefined) {
    return Promise.reject(
      helpers.settleArtifactFailure(
        state,
        instance,
        hash,
        { id, op },
        new WorkflowError(
          "ArtifactStoreUnavailable",
          `Cannot publish "${id}": this host has no artifact store (at ${refToString(instance)}).`,
        ),
      ),
    );
  }

  state.journal.putNode({
    runId: state.runId,
    siteId,
    ordinal: instance.ordinal,
    kind: "artifact",
    inputHash: hash,
    status: "running",
    artifactId: id,
  });

  const request: ArtifactPublishRequest = {
    runId: state.runId,
    siteId,
    ordinal: instance.ordinal,
    op,
    id,
    version,
    ...(op === "file" ? { path: payload } : { content: payload }),
    ...(args[2] === undefined ? {} : { opts: args[2] }),
  };
  return publish.call(state.driver, request).then(
    (record) =>
      helpers.settleArtifactPublish(state, instance, hash, { id, op, version, primary }, record),
    (cause: unknown) => {
      const err =
        cause instanceof WorkflowError
          ? cause
          : new WorkflowError("DriverError", `Artifact publish failed: ${op} "${id}".`, {
              cause,
            });
      throw helpers.settleArtifactFailure(state, instance, hash, { id, op }, err);
    },
  );
}
