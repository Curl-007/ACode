// ============================================================
// jcode 桥接：self-dev 防护（spec R4-3）
//
// 风险：jcode 在**自己的源码检出目录**里启动普通 session 会自动进 self-dev 模式
// （jcode src/cli/dispatch.rs:863-871：`in_jcode_repo && !already_in_selfdev
// && !args.no_selfdev` → 打印 "Detected jcode repository - enabling self-dev
// mode"）。self-dev 让 LLM 可自主改写 jcode 自己的源码、`cargo build` 后重指
// shared-server symlink 并热重载二进制——即 agent 能替换 ACode 所分发/信任的
// 可执行文件，绕过全部 SHA256/签名/provenance 校验，且 `cargo build` 会以
// daemon 用户权限在编译期执行任意 build.rs。这与 ACode 的供应链锁定与 fail-closed
// 纪律正面冲突，必须在 spawn 前拒绝。
//
// 判别与上游 is_jcode_repo（jcode crates/jcode-build-support/src/paths.rs:599-620）
// 逐条对齐，避免两侧漂移导致漏判或误拒：
//   1. <cwd>/Cargo.toml 存在
//   2. <cwd>/.git 存在（目录或 worktree 的 gitdir 文件）
//   3. Cargo.toml 内容含 name = "jcode"
// 上游同样只检查 cwd 本身、不向上遍历祖先目录，本实现保持一致（见「诚实边界」）。
//
// 外部 I/O 收敛（根 AGENTS.md）：本模块不直接调 node:fs，经注入的 probe 读写，
// 使纯逻辑可单测、真实 I/O 只发生在调用方（adapter 层）。
// ============================================================

/** Cargo.toml 里标识 jcode 主包的字符串（与上游 `content.contains("name = \"jcode\"")` 同源）。 */
const JCODE_PACKAGE_MARKER = 'name = "jcode"';

/** 读文件文本；不存在或不可读时返回 null（不抛——探测失败按「非 jcode 仓库」处理）。 */
export interface JcodeRepoProbe {
  /** 路径是否存在（目录或文件均可）。 */
  exists(path: string): boolean;
  /** 读文本；失败返回 null。 */
  readTextOrNull(path: string): string | null;
  /** 拼接子路径（由调用方提供跨平台 path.join，避免本模块手写分隔符）。 */
  join(dir: string, child: string): string;
}

export interface JcodeRepoVerdict {
  /** 是否为 jcode 源码检出（须拒绝 spawn）。 */
  isJcodeRepo: boolean;
  /** 判为 true 时说明命中了哪些特征，供错误信息与日志留痕。 */
  matchedMarkers: readonly string[];
}

/**
 * 判定 cwd 是否为 jcode 源码检出。
 *
 * 三条特征全中才判 true（与上游 `&&` 链一致）：Cargo.toml 存在、.git 存在、
 * Cargo.toml 含 jcode 包名标记。任一不满足即 false——避免把普通 Rust 项目或
 * 恰好含 Cargo.toml 的用户工作区误拒。
 *
 * 探测异常一律视为「无法确认」→ 返回 false 但带空 matchedMarkers；调用方若要求
 * 严格模式可自行升级为拒绝（本函数不做策略裁决，只做事实判定）。
 */
export function detectJcodeRepo(cwd: string, probe: JcodeRepoProbe): JcodeRepoVerdict {
  const cargoToml = probe.join(cwd, "Cargo.toml");
  if (!probe.exists(cargoToml)) {
    return { isJcodeRepo: false, matchedMarkers: [] };
  }
  // worktree 的 .git 是文件不是目录，上游用 exists() 同时覆盖两者，这里一致。
  if (!probe.exists(probe.join(cwd, ".git"))) {
    return { isJcodeRepo: false, matchedMarkers: [] };
  }
  const content = probe.readTextOrNull(cargoToml);
  if (content === null || !content.includes(JCODE_PACKAGE_MARKER)) {
    return { isJcodeRepo: false, matchedMarkers: [] };
  }
  return {
    isJcodeRepo: true,
    matchedMarkers: ["Cargo.toml", ".git", JCODE_PACKAGE_MARKER],
  };
}

/**
 * self-dev 防护的错误文案（单一事实源，供 spawn 拒绝与测试断言共用）。
 * 不含路径以外的敏感信息；cwd 由调用方传入以便排障。
 */
export function describeSelfdevRejection(cwd: string, markers: readonly string[]): string {
  return (
    `refusing to spawn jcode with cwd inside a jcode source checkout (${cwd}): ` +
    `jcode auto-enables self-dev mode there, which lets the agent rewrite and ` +
    `hot-reload its own binary and bypass signature/provenance checks ` +
    `(matched: ${markers.join(", ")}). Choose a normal workspace directory.`
  );
}

/**
 * 诚实边界（记录，不在本模块修）：
 *
 * - 与上游一致只查 cwd 本身。若用户把**工作区嵌套在 jcode 检出内部**（cwd 是
 *   jcode repo 的子目录），上游同样不会触发 self-dev（它只看 cwd），故本防护
 *   不需要向上遍历；向上遍历反而会误拒合法子目录工作区。
 * - 本防护是 spawn 前的静态判定。运行期 jcode 若经其他路径（如 `jcode self-dev`
 *   子命令、canary session 标记）进入 self-dev，不在本模块覆盖范围——shim 只以
 *   `acp` 子命令 + `--no-selfdev` 启动，不给这些路径入口（spec R4-3）。
 */
