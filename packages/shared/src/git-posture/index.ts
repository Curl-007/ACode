// ============================================================
// Git Posture 网关入口（packages/services/specs/git-posture-gateway.md）
// 判定表与解析助手在 shapes.ts；按档应用器拆分于
// applyWrite.ts（infra/push/fetch/merge/populate/clone）与
// applyRead.ts（scrub/hydrate/read）。本文件只保留入口与公共再导出
// （400 行 max-lines 棘轮，先例 platformIpcRegistry 拆分）。
// 单一所有者：services 漏斗与 acode-cli 孪生漏斗共用本模块（spec R5/R6）。
// ============================================================

import {
  ENFORCED_POSTURES,
  SUBMODULE_RECURSE_GUARDED_SUBCOMMANDS,
  isFlagAbbrevOf,
  parseGitArgs,
} from "./shapes.js";
import type { GitPosture } from "./shapes.js";
import {
  applyClonePosture,
  applyFetchPosture,
  applyInfraPosture,
  applyMergePosture,
  applyPopulatePosture,
  applyPushPosture,
} from "./applyWrite.js";
import { applyHydratePosture, applyReadPosture, applyScrubPosture } from "./applyRead.js";

export function applyGitPostureGateway(posture: GitPosture, args: readonly string[]): string[] {
  if (posture === "infra") {
    return applyInfraPosture(posture, args);
  }
  const parsed = parseGitArgs(posture, args);
  // 闭集守卫：类型外的档位值（未类型化 JS 调用方）不进入白名单判定，
  // 与证据 :373 同语义（透传由调用方类型约束兜底；本函数对闭集内档位全强制）。
  if (!ENFORCED_POSTURES.has(posture)) {
    return [...args];
  }
  const { subcommand, preDash, fail } = parsed;
  // 全档位 recurse-submodules 守卫（证据 :379-390，spec 威胁 5）。
  if (subcommand !== undefined && SUBMODULE_RECURSE_GUARDED_SUBCOMMANDS.has(subcommand)) {
    const recurseFlag = preDash.find(
      (token) =>
        isFlagAbbrevOf(token, "recurse-submodules") &&
        token !== "--no-recurse-submodules" &&
        token !== "--recurse-submodules=no",
    );
    if (recurseFlag !== undefined) {
      fail(`${subcommand} ${recurseFlag}`);
    }
  }
  switch (posture) {
    case "push":
    case "pushProbe":
      return applyPushPosture(parsed);
    case "fetch":
      return applyFetchPosture(parsed);
    case "merge":
      return applyMergePosture(parsed);
    case "populate":
      return applyPopulatePosture(parsed);
    case "scrub":
      return applyScrubPosture(parsed);
    case "hydrate":
      return applyHydratePosture(parsed);
    case "read":
      return applyReadPosture(parsed);
    case "clone":
      return applyClonePosture(parsed);
    default:
      return [...args];
  }
}

export {
  DEFAULT_GIT_POSTURE,
  GIT_POSTURES,
  GIT_POSTURE_ERROR_CODE,
  GitPostureError,
} from "./shapes.js";
export type { GitPosture } from "./shapes.js";
