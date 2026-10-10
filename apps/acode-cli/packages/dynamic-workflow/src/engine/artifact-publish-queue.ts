import type { EngineState } from "./engine-state.js";

/** New ids share one admission lane so the run-level id cap cannot be overshot concurrently. */
export const NEW_ARTIFACT_ID_QUEUE_KEY = Symbol("new-artifact-id");

/** Serialize content artifact admission per id; the queue carries no journal fact. */
export function queueArtifactPublish<T>(
  state: EngineState,
  id: string | symbol,
  publish: () => Promise<T>,
): Promise<T> {
  const previous = state.artifactPublishTails.get(id) ?? Promise.resolve();
  const current = previous.then(publish);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  state.artifactPublishTails.set(id, tail);
  void tail.finally(() => {
    if (state.artifactPublishTails.get(id) === tail) state.artifactPublishTails.delete(id);
  });
  return current;
}
