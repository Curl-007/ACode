import {
  CLONE_DEPTH_PATTERN,
  CLONE_EXACT_FLAGS,
  CLONE_FILTER_PREFIXES,
  CLONE_VALUE_FLAGS,
  FETCH_ALLOWED_EXACT_FLAGS,
  FETCH_BANNED_FLAG_NAMES,
  FETCH_REFSPEC_PATTERN,
  FETCH_SHALLOW_FLAG_NAMES,
  GitPostureError,
  LS_REMOTE_BANNED_FLAG_NAMES,
  POPULATE_CHECKOUT_FLAGS,
  POSITION_HIJACK_FLAGS,
  PUSH_BANNED_FLAG_NAMES,
  PUSH_REFSPEC_PATTERN,
  SHA_PATTERN,
  findSubcommandIndex,
  isFlagAbbrevOf,
  matchesMergeShaShape,
} from "./shapes.js";
import type { GitPosture, ParsedGitArgs } from "./shapes.js";

export function applyInfraPosture(posture: GitPosture, args: readonly string[]): string[] {
  const argv = [...args];
  const index = findSubcommandIndex(argv);
  const subcommand = argv[index];
  if (
    subcommand !== undefined &&
    POSITION_HIJACK_FLAGS.some((flag) => subcommand === flag || subcommand.startsWith(`${flag}=`))
  ) {
    throw new GitPostureError(posture, subcommand);
  }
  if (
    subcommand === "worktree" &&
    argv[index + 1] === "add" &&
    !argv.slice(index + 2).includes("--no-checkout")
  ) {
    throw new GitPostureError(posture, "worktree add without --no-checkout");
  }
  return argv;
}

/** push/pushProbe 档（证据 :391-421，spec R3/R4-1：强制具体 refspec）。 */
export function applyPushPosture(parsed: ParsedGitArgs): string[] {
  const { subcommand, rest, dashIndex, preDash, splice, fail } = parsed;
  if (subcommand !== "push") {
    fail(subcommand ?? "(no subcommand)");
  }
  const afterDash = dashIndex === -1 ? [] : rest.slice(dashIndex + 1);
  if (
    dashIndex !== -1 &&
    (preDash.some((token) => !token.startsWith("-")) ||
      afterDash.length < 2 ||
      (afterDash[0] ?? "").startsWith("-"))
  ) {
    fail("push --");
  }
  const bannedFlag = preDash.find(
    (token) =>
      token === "-" ||
      /^-[^-]/.test(token) ||
      PUSH_BANNED_FLAG_NAMES.some((name) => isFlagAbbrevOf(token, name)),
  );
  if (bannedFlag !== undefined) {
    fail(`push ${bannedFlag}`);
  }
  // 位置参数 = remote + ≥1 个具体 refspec（`src:dst` 冒号形态）；
  // 裸 push / `push <remote> <branch>`（隐式上游推断形状）拒绝。
  const effective =
    dashIndex === -1 ? preDash.filter((token) => !token.startsWith("-")) : afterDash;
  const refspecs = effective.slice(1);
  if (
    effective.length < 2 ||
    refspecs.some((refspec) => !PUSH_REFSPEC_PATTERN.test(refspec)) ||
    refspecs.some((refspec) => refspec.endsWith(":refs/heads/HEAD"))
  ) {
    fail(`push ${rest.join(" ")} (a concrete refspec is required)`);
  }
  return splice("--no-recurse-submodules", "--no-follow-tags");
}

/** fetch 档（证据 :422-494，spec R3/威胁 2：argv 重建钉死恶意 .git/config 武器化键）。 */
export function applyFetchPosture(parsed: ParsedGitArgs): string[] {
  const { argv, subcommandIndex, subcommand, dashIndex, preDash, fail } = parsed;
  if (subcommand === "fetch") {
    const shallowFlag = preDash.find((token) =>
      FETCH_SHALLOW_FLAG_NAMES.some((name) => isFlagAbbrevOf(token, name)),
    );
    if (shallowFlag !== undefined) {
      fail(`fetch ${shallowFlag}`);
    }
    const fetchPositionals = preDash.filter((token) => !token.startsWith("-"));
    const remote = fetchPositionals[0];
    if (remote === undefined) {
      // return 形态确保 TS 控制流收窄（fail 返回 never）。
      return fail("fetch (no remote)");
    }
    const refspecs = fetchPositionals.slice(1);
    if (dashIndex !== -1) {
      fail("fetch --");
    }
    const bannedFlag = preDash.find(
      (token) =>
        !FETCH_ALLOWED_EXACT_FLAGS.has(token) &&
        (/^-[^-]/.test(token) ||
          FETCH_BANNED_FLAG_NAMES.some((name) => isFlagAbbrevOf(token, name))),
    );
    if (bannedFlag !== undefined) {
      fail(`fetch ${bannedFlag}`);
    }
    for (const refspec of refspecs) {
      const destination = refspec.slice(refspec.indexOf(":") + 1);
      if (
        !FETCH_REFSPEC_PATTERN.test(refspec) ||
        !destination.startsWith(`refs/remotes/${remote}/`) ||
        destination === `refs/remotes/${remote}/HEAD`
      ) {
        fail(`fetch refspec ${refspec}`);
      }
    }
    // argv 重建：`-c` 钉死 prune/pruneTags/mirror/followRemoteHEAD 武器化键
    // （command scope 压过仓库/全局 config），归一防御旗标，保留其余合法旗标。
    const keptFlags = preDash.filter(
      (token) => token.startsWith("-") && !FETCH_ALLOWED_EXACT_FLAGS.has(token),
    );
    return [
      ...argv.slice(0, subcommandIndex),
      "-c",
      "fetch.prune=false",
      "-c",
      `remote.${remote}.prune=false`,
      "-c",
      "fetch.pruneTags=false",
      "-c",
      `remote.${remote}.pruneTags=false`,
      "-c",
      `remote.${remote}.mirror=false`,
      "-c",
      `remote.${remote}.followRemoteHEAD=never`,
      "fetch",
      "--no-recurse-submodules",
      "--no-tags",
      "--refmap=",
      ...keptFlags,
      remote,
      ...refspecs,
    ];
  }
  if (subcommand === "ls-remote") {
    const bannedFlag = preDash.find(
      (token) =>
        /^-[^-]/.test(token) ||
        LS_REMOTE_BANNED_FLAG_NAMES.some((name) => isFlagAbbrevOf(token, name)),
    );
    if (bannedFlag !== undefined) {
      fail(`ls-remote ${bannedFlag}`);
    }
    return [...argv];
  }
  return fail(subcommand ?? "(no subcommand)");
}

/** merge 档（证据 :323-363 `Ce` + :495）。 */
export function applyMergePosture(parsed: ParsedGitArgs): string[] {
  const { argv, subcommand, rest, dashIndex, splice, fail } = parsed;
  const hasLiteralPathspecs = argv
    .slice(0, Math.max(findSubcommandIndex(argv), 0))
    .includes("--literal-pathspecs");
  const dashTailUsable =
    dashIndex !== -1 &&
    rest.length > dashIndex + 1 &&
    rest.slice(dashIndex + 1).every((token) => token.length > 0);
  const denyDetail = `${subcommand ?? "(no subcommand)"} ${rest.join(" ")}`.trim();
  switch (subcommand) {
    case "merge":
      if (
        (rest.length === 1 && rest[0] === "--abort") ||
        matchesMergeShaShape(rest, ["--ff-only", "--no-overwrite-ignore"], ["--quiet"], false) ||
        matchesMergeShaShape(
          rest,
          ["--no-ff", "--no-commit", "--no-overwrite-ignore"],
          ["--quiet"],
          true,
        )
      ) {
        return [...argv];
      }
      return fail(denyDetail);
    case "checkout":
      if (
        hasLiteralPathspecs &&
        dashIndex === 1 &&
        SHA_PATTERN.test(rest[0] ?? "") &&
        dashTailUsable
      ) {
        return splice("--no-recurse-submodules");
      }
      return fail(denyDetail);
    case "rm": {
      const preDashTokens = rest.slice(0, dashIndex === -1 ? rest.length : dashIndex);
      if (
        hasLiteralPathspecs &&
        dashIndex === 2 &&
        dashTailUsable &&
        preDashTokens.length === 2 &&
        preDashTokens.includes("--quiet") &&
        preDashTokens.includes("--force")
      ) {
        return [...argv];
      }
      return fail(denyDetail);
    }
    case "commit": {
      const messageIndex = rest.indexOf("-m");
      const message = messageIndex === -1 ? undefined : rest[messageIndex + 1];
      const withoutMessage =
        messageIndex === -1
          ? []
          : [...rest.slice(0, messageIndex), ...rest.slice(messageIndex + 2)];
      if (
        messageIndex !== -1 &&
        message !== undefined &&
        !message.startsWith("-") &&
        withoutMessage.length === 2 &&
        withoutMessage.includes("--quiet") &&
        withoutMessage.includes("--no-verify")
      ) {
        return [...argv];
      }
      return fail(denyDetail);
    }
    default:
      return fail(denyDetail);
  }
}

/** populate 档（证据 :496-509）。 */
export function applyPopulatePosture(parsed: ParsedGitArgs): string[] {
  const { argv, subcommand, rest, positionals, preDash, splice, fail } = parsed;
  switch (subcommand) {
    case "checkout": {
      const bannedFlag = preDash.find(
        (token) => token.startsWith("-") && !POPULATE_CHECKOUT_FLAGS.has(token),
      );
      if (bannedFlag !== undefined || positionals.length === 0) {
        return fail(`checkout ${rest.join(" ")}`);
      }
      return splice("--quiet", "--no-recurse-submodules");
    }
    case "read-tree":
      if (rest.length !== 1 || positionals.length !== 1) {
        return fail(`read-tree ${rest.join(" ")}`);
      }
      return [...argv];
    default:
      return fail(subcommand ?? "(no subcommand)");
  }
}

/** scrub 档（证据 :510-633）。 */

/**
 * clone 档（spec R3 clone 行 / R4-9，ACode 第 10 档——证据无对应档，网络+写复合面裁决）：
 * 位置参 = url[+dest]；旗标 ⊆ CLONE_EXACT_FLAGS ∪ 名值旗标（--origin/--branch/--depth，
 * 空格或 `=` 形态）∪ `--filter=` 前缀闭集；闭集外一律拒（upload-pack/exec/-c/--config/
 * mirror/recurse-submodules/shallow-since/shallow-exclude 自然落集外）。通过时不重写
 * argv——子模块扇出由 E1 config 层 `submodule.recurse=false` 钉死（spec R4-9 两层关系）。
 */
export function applyClonePosture(parsed: ParsedGitArgs): string[] {
  const { argv, subcommand, rest, fail } = parsed;
  // 全局/命令级配置注入：`-c` 对（子命令位之前，parseGitArgs 会跳过，故对完整 argv
  // 显式扫描）与 `--config`/`--config=` 一律拒。
  if (
    argv.some((token) => token === "-c" || token === "--config" || token.startsWith("--config="))
  ) {
    return fail("clone -c/--config");
  }
  if (subcommand !== "clone") {
    return fail(subcommand ?? "(no subcommand)");
  }
  if (rest.includes("--")) {
    return fail("clone --");
  }
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (CLONE_EXACT_FLAGS.has(token)) {
      continue;
    }
    if (token.startsWith("--filter=")) {
      const value = token.slice("--filter=".length);
      if (CLONE_FILTER_PREFIXES.some((prefix) => value.startsWith(prefix))) {
        continue;
      }
      return fail(`clone ${token}`);
    }
    const eqIndex = token.indexOf("=");
    const flagName = eqIndex === -1 ? token : token.slice(0, eqIndex);
    if (CLONE_VALUE_FLAGS.has(flagName)) {
      if (eqIndex === -1) {
        const value = rest[index + 1];
        if (
          value === undefined ||
          value.startsWith("-") ||
          (flagName === "--depth" && !CLONE_DEPTH_PATTERN.test(value))
        ) {
          return fail(`clone ${token} (bad value)`);
        }
        index += 1;
        continue;
      }
      const value = token.slice(eqIndex + 1);
      if (value === "" || (flagName === "--depth" && !CLONE_DEPTH_PATTERN.test(value))) {
        return fail(`clone ${token} (bad value)`);
      }
      continue;
    }
    return fail(`clone ${token}`);
  }
  if (positionals.length < 1 || positionals.length > 2) {
    return fail(`clone ${rest.join(" ")} (url [dest] expected)`);
  }
  return [...argv];
}
