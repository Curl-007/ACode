import {
  ACODE_READ_SUBCOMMAND_ADDITIONS,
  BAD_REMOTE_REF_PATTERN,
  BRANCH_REF_PATTERN,
  CONFIG_READ_FLAGS,
  EVIDENCE_READ_SUBCOMMANDS,
  LFS_LS_FILES_FLAGS,
  NON_ZERO_SHA_PATTERN,
  READ_BRANCH_FLAGS,
  READ_SYMBOLIC_REF_FLAGS,
  REMOTE_HEAD_PATTERN,
  REMOTE_REF_PREFIX_PATTERN,
  SHA_PATTERN,
  SKIP_WORKTREE_FLAGS,
  hasControlChar,
  isFlagAbbrevOf,
} from "./gitPostureGatewayShapes.js";
import type { ParsedGitArgs } from "./gitPostureGatewayShapes.js";

export function applyScrubPosture(parsed: ParsedGitArgs): string[] {
  const { argv, subcommand, rest, positionals, dashIndex, preDash, splice, fail } = parsed;
  const preDashFlags = preDash.filter((token) => token.startsWith("-"));
  switch (subcommand) {
    case "clean":
      return [...argv];
    case "read-tree":
      if (
        (rest.length === 3 &&
          rest[0] === "--reset" &&
          rest[1] === "-u" &&
          NON_ZERO_SHA_PATTERN.test(rest[2] ?? "")) ||
        (preDashFlags.length === 2 &&
          preDashFlags.includes("-m") &&
          preDashFlags.includes("-u") &&
          positionals.length === 2 &&
          positionals.every((token) => NON_ZERO_SHA_PATTERN.test(token)) &&
          dashIndex === -1)
      ) {
        return splice("--no-recurse-submodules");
      }
      return fail(`read-tree ${rest.join(" ")}`);
    case "maintenance": {
      const allowedTokens = new Set([
        "run",
        "--auto",
        "--quiet",
        "--task=loose-objects",
        "--task=incremental-repack",
      ]);
      const extraToken = rest.find((token) => !allowedTokens.has(token));
      if (
        rest[0] !== "run" ||
        extraToken !== undefined ||
        !rest.some((token) => token.startsWith("--task="))
      ) {
        return fail(`maintenance ${rest.join(" ")}`);
      }
      return [...argv];
    }
    case "update-ref":
      return applyScrubUpdateRef(parsed);
    case "symbolic-ref": {
      const headTarget = rest[1] ?? "";
      if (
        rest.length === 2 &&
        rest[0] === "HEAD" &&
        BRANCH_REF_PATTERN.test(headTarget) &&
        !headTarget.includes("..")
      ) {
        return [...argv];
      }
      const remoteHead = REMOTE_HEAD_PATTERN.exec(rest[0] ?? "");
      const remotePrefix = remoteHead ? `refs/remotes/${remoteHead[1]}/` : null;
      if (
        rest.length !== 2 ||
        remotePrefix === null ||
        !headTarget.startsWith(remotePrefix) ||
        headTarget === rest[0] ||
        BAD_REMOTE_REF_PATTERN.test(headTarget)
      ) {
        return fail(`symbolic-ref ${rest.join(" ")}`);
      }
      return [...argv];
    }
    case "update-index":
      if (
        (rest.length === 3 &&
          rest[0] === "-q" &&
          rest[1] === "--ignore-submodules" &&
          rest[2] === "--refresh") ||
        (rest.length === 3 &&
          SKIP_WORKTREE_FLAGS.has(rest[0]!) &&
          rest[1] === "-z" &&
          rest[2] === "--stdin")
      ) {
        return [...argv];
      }
      return fail(`update-index ${rest.join(" ")}`);
    default:
      return fail(subcommand ?? "(no subcommand)");
  }
}

/** scrub 档 update-ref 形状（证据 :542-608）：stash 形重建 / -d 删除形 / 更新形，强制 --no-deref。 */
function applyScrubUpdateRef(parsed: ParsedGitArgs): string[] {
  const { argv, subcommandIndex, rest, dashIndex, preDash, splice, fail } = parsed;
  const withNoDeref = (): string[] =>
    preDash.includes("--no-deref") ? [...argv] : splice("--no-deref");
  const tokens = preDash[0] === "--no-deref" ? preDash.slice(1) : [...preDash];

  // stash 形：--create-reflog -m <msg> refs/stash <非零sha>，重建并强制 --no-deref。
  if (
    dashIndex === -1 &&
    tokens.length === 5 &&
    tokens[0] === "--create-reflog" &&
    tokens[1] === "-m" &&
    !(tokens[2] ?? "-").startsWith("-") &&
    !hasControlChar(tokens[2] ?? "") &&
    tokens[3] === "refs/stash" &&
    NON_ZERO_SHA_PATTERN.test(tokens[4] ?? "")
  ) {
    return [
      ...argv.slice(0, subcommandIndex + 1),
      "--no-deref",
      "--create-reflog",
      "-m",
      tokens[2] ?? "",
      "refs/stash",
      tokens[4] ?? "",
    ];
  }

  const messageIndex = preDash.indexOf("-m");
  if (messageIndex !== -1 && (preDash[messageIndex + 1] ?? "-").startsWith("-")) {
    return fail(`update-ref ${rest.join(" ")}`);
  }
  let remaining = preDash.filter((token) => token !== "--no-deref");
  const hasMessage =
    remaining[0] === "-m" &&
    remaining.length > 1 &&
    !(remaining[1] ?? "-").startsWith("-") &&
    !hasControlChar(remaining[1] ?? "");
  if (hasMessage) {
    remaining = remaining.slice(2);
  }
  if (remaining.some((token) => token.startsWith("-") && token !== "-d") || dashIndex !== -1) {
    return fail(`update-ref ${rest.join(" ")}`);
  }

  if (remaining[0] === "-d") {
    const refName = remaining[1] ?? "";
    const oldValue = remaining[2];
    const bisectDelete =
      refName.startsWith("refs/bisect/") &&
      (oldValue === undefined || NON_ZERO_SHA_PATTERN.test(oldValue));
    const branchDelete =
      refName.startsWith("refs/heads/") && NON_ZERO_SHA_PATTERN.test(oldValue ?? "");
    if (hasMessage || !(bisectDelete || branchDelete) || remaining.length > 3) {
      return fail(`update-ref ${rest.join(" ")}`);
    }
    return withNoDeref();
  }

  const branchUpdate =
    remaining.length === 3 &&
    NON_ZERO_SHA_PATTERN.test(remaining[1] ?? "") &&
    NON_ZERO_SHA_PATTERN.test(remaining[2] ?? "") &&
    ((remaining[0] ?? "").startsWith("refs/heads/") ||
      (!hasMessage && remaining[0] === "HEAD" && remaining[1] === remaining[2]));
  const remoteUpdate =
    !hasMessage &&
    (remaining.length === 2 || remaining.length === 3) &&
    REMOTE_REF_PREFIX_PATTERN.test(remaining[0] ?? "") &&
    NON_ZERO_SHA_PATTERN.test(remaining[1] ?? "") &&
    (remaining.length === 2 || NON_ZERO_SHA_PATTERN.test(remaining[2] ?? ""));
  if (branchUpdate || remoteUpdate) {
    return withNoDeref();
  }
  return fail(`update-ref ${rest.join(" ")}`);
}

/** hydrate 档（证据 :634-641）。 */
export function applyHydratePosture(parsed: ParsedGitArgs): string[] {
  const { argv, subcommand, rest, fail } = parsed;
  if (
    subcommand === "update-index" &&
    rest.length === 2 &&
    rest[0] === "-q" &&
    rest[1] === "--refresh"
  ) {
    return [...argv];
  }
  if (subcommand !== "lfs") {
    return fail(subcommand ?? "(no subcommand)");
  }
  const [lfsSubcommand, ...lfsRest] = rest;
  if (lfsSubcommand === "checkout") {
    const dashIndex = lfsRest.indexOf("--");
    if ((dashIndex === -1 ? lfsRest : lfsRest.slice(0, dashIndex)).length === 0) {
      return [...argv];
    }
  } else if (
    lfsSubcommand === "ls-files" &&
    lfsRest.every((token) => LFS_LS_FILES_FLAGS.has(token))
  ) {
    return [...argv];
  }
  return fail(`lfs ${rest.join(" ")}`);
}

/** read 档（证据 :642-687 + ACode 登记增补，spec R3/R4-2）。 */
export function applyReadPosture(parsed: ParsedGitArgs): string[] {
  const { argv, subcommand, rest, positionals, dashIndex, preDash, splice, fail } = parsed;
  if (
    subcommand === undefined ||
    (!EVIDENCE_READ_SUBCOMMANDS.has(subcommand) && !ACODE_READ_SUBCOMMAND_ADDITIONS.has(subcommand))
  ) {
    return fail(subcommand ?? "(no subcommand)");
  }
  const bannedSubmoduleFlag = preDash.find(
    (token) =>
      (isFlagAbbrevOf(token, "ignore-submodules") &&
        token !== "--ignore-submodules=dirty" &&
        token !== "--ignore-submodules=all") ||
      (isFlagAbbrevOf(token, "submodule") && token !== "--submodule=short"),
  );
  if (bannedSubmoduleFlag !== undefined) {
    return fail(`${subcommand} ${bannedSubmoduleFlag}`);
  }
  switch (subcommand) {
    case "diff":
    case "log":
    case "show":
      return splice("--ignore-submodules=dirty", "--submodule=short");
    case "status":
      return splice("--ignore-submodules=dirty");
    case "remote":
      // ACode 增补（spec R4-2）：无参列表（listRemotes）；证据仅允许 get-url。
      if (rest.length === 0) {
        return [...argv];
      }
      if (rest[0] !== "get-url") {
        return fail(`remote ${rest[0] ?? ""}`.trim());
      }
      return [...argv];
    case "branch":
      if (
        rest.length === 0 ||
        !rest.some((token) => READ_BRANCH_FLAGS.has(token)) ||
        rest.some(
          (token) =>
            token.startsWith("-") &&
            !READ_BRANCH_FLAGS.has(token) &&
            !token.startsWith("--format="),
        )
      ) {
        return fail(`branch ${rest.join(" ")}`.trim());
      }
      return [...argv];
    case "symbolic-ref":
      if (
        positionals.length !== 1 ||
        rest.some((token) => token.startsWith("-") && !READ_SYMBOLIC_REF_FLAGS.has(token))
      ) {
        return fail(`symbolic-ref ${rest.join(" ")}`);
      }
      return [...argv];
    case "hash-object":
      if (rest.includes("-w")) {
        return fail("hash-object -w");
      }
      return [...argv];
    case "cat-file": {
      const batchCheck = rest.length === 1 && rest[0] === "--batch-check";
      const typedObject =
        rest.length === 2 &&
        (rest[0] === "commit" || rest[0] === "tree") &&
        SHA_PATTERN.test(rest[1] ?? "");
      if (!batchCheck && !typedObject) {
        return fail(`cat-file ${rest.join(" ")}`.trim());
      }
      return [...argv];
    }
    case "config": {
      // ACode 增补（spec R4-2）：只读形。旗标闭集且必含 --get、恰 1 个键、无 `--`；
      // 写形（`config k v`/--unset/--add/-f 等）拒绝。
      const flags = rest.filter((token) => token.startsWith("-"));
      const keys = rest.filter((token) => !token.startsWith("-"));
      if (
        dashIndex !== -1 ||
        !flags.includes("--get") ||
        flags.some((token) => !CONFIG_READ_FLAGS.has(token)) ||
        keys.length !== 1
      ) {
        return fail(`config ${rest.join(" ")}`);
      }
      return [...argv];
    }
    case "check-ref-format": {
      // ACode 增补（spec R4-2）：纯语法校验器，仅 --branch 形。
      const flags = rest.filter((token) => token.startsWith("-"));
      const names = rest.filter((token) => !token.startsWith("-"));
      if (flags.some((token) => token !== "--branch") || names.length !== 1) {
        return fail(`check-ref-format ${rest.join(" ")}`);
      }
      return [...argv];
    }
    default:
      return [...argv];
  }
}

/**
 * posture 网关主体（证据 :364-687 `we`）：按声明档位对 argv 做精确形状白名单。
 * 通过返回（可能重写的）argv 新数组；拒绝抛 GitPostureError。纯函数，零副作用。
 */
