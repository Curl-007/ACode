// ============================================================
// P0：进程内 TypeScript 语义诊断（Program 缓存增量复用）
// ============================================================
// 库内先例：apps/acode-cli/packages/dynamic-workflow/src/compiler/compile.ts:99,117
// 的 ts.createProgram 模式。本模块按 tsconfig（向上查找，无则按文件所在目录）
// 缓存 Program + 同源持久 CompilerHost，后续调用传 oldProgram 增量复用：
// 复用正确性的前提是**同一 host 缓存**——unchanged 文件返回同一 SourceFile
// 实例（结构直接复用），changed 文件按 mtime/size 失效重读（局部重编译）。
// 只取目标文件的 syntactic+semantic 诊断，不做全工程检查（全工程交给 P1 LSP）。

import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { limitDiagnosticMessages, formatDiagnosticsSummary, formatPathRelativeToCwd } from "./format.js";
import type { Diagnostic as LspDiagnostic, FileDiagnosticsResult } from "./types.js";

const IN_PROCESS_SERVER_NAME = "typescript(in-process)";
/** 无 tsconfig 时的默认编译面（贴近常见 TS 项目）。 */
const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: false,
  esModuleInterop: true,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: true,
  strict: false,
  target: ts.ScriptTarget.ES2022,
};

interface CachedEntry {
  sourceFile: ts.SourceFile;
  mtimeMs: number;
  sizeBytes: number;
}

interface PersistentHostState {
  compilerOptions: ts.CompilerOptions;
  /** 规范化路径 → (SourceFile + 读取时的 stat)，mtime/size 变化即失效。 */
  files: Map<string, CachedEntry>;
}

interface CachedProgram {
  program: ts.Program;
  hostState: PersistentHostState;
}

/** tsconfig 路径（或无 tsconfig 的目录）→ 缓存 Program。单槽增量复用。 */
const programCache = new Map<string, CachedProgram>();

function findTsconfig(fromDir: string): string | null {
  let dir = path.resolve(fromDir);
  for (;;) {
    const candidate = path.join(dir, "tsconfig.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function canonicalKey(fileName: string): string {
  return process.platform === "win32" ? fileName.toLowerCase() : fileName;
}

function statOrUndefined(fileName: string): { mtimeMs: number; sizeBytes: number } | undefined {
  try {
    const stat = fs.statSync(fileName);
    return { mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
  } catch {
    return undefined;
  }
}

/**
 * 持久 host 的 SourceFile 获取：同 key 未变（mtime+size 相同）返回同一实例，
 * changed 重读重建，消失的文件出缓存。oldProgram 结构复用依赖此稳定身份。
 */
function getSourceFileWithCache(
  state: PersistentHostState,
  fileName: string,
  languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions,
): ts.SourceFile | undefined {
  const key = canonicalKey(fileName);
  const stat = statOrUndefined(fileName);
  if (!stat) {
    state.files.delete(key);
    return undefined;
  }
  const cached = state.files.get(key);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.sizeBytes === stat.sizeBytes) {
    return cached.sourceFile;
  }
  let text: string;
  try {
    text = fs.readFileSync(fileName, "utf8");
  } catch {
    state.files.delete(key);
    return undefined;
  }
  const sourceFile = ts.createSourceFile(fileName, text, languageVersionOrOptions, true);
  state.files.set(key, { sourceFile, mtimeMs: stat.mtimeMs, sizeBytes: stat.sizeBytes });
  return sourceFile;
}

function createHost(state: PersistentHostState): ts.CompilerHost {
  return {
    getSourceFile: (fileName, languageVersionOrOptions) =>
      getSourceFileWithCache(state, fileName, languageVersionOrOptions),
    getDefaultLibFileName: (options) => ts.getDefaultLibFileName(options),
    getDefaultLibLocation: () => path.dirname(ts.getDefaultLibFilePath(state.compilerOptions)),
    writeFile: () => {
      // noEmit：诊断回路绝不写输出。
    },
    getCurrentDirectory: () => process.cwd(),
    getDirectories: (directory) => {
      try {
        return fs.readdirSync(directory, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        return [];
      }
    },
    getCanonicalFileName: canonicalKey,
    useCaseSensitiveFileNames: () => process.platform !== "win32",
    getNewLine: () => "\n",
    fileExists: (fileName) => fs.existsSync(fileName),
    readFile: (fileName) => {
      try {
        return fs.readFileSync(fileName, "utf8");
      } catch {
        return undefined;
      }
    },
    directoryExists: (directory) => fs.existsSync(directory) && fs.statSync(directory).isDirectory(),
  };
}

function buildProgram(tsconfigPath: string | null, targetFile: string, old?: CachedProgram): CachedProgram {
  let compilerOptions = DEFAULT_COMPILER_OPTIONS;
  let rootNames: string[] = [];
  if (tsconfigPath) {
    // 标准读取链：readConfigFile → parseJsonConfigFileContent（走 ts.sys）。
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (!configFile.error) {
      const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(tsconfigPath));
      compilerOptions = { ...parsed.options, noEmit: true };
      rootNames = parsed.fileNames;
    }
  }
  if (rootNames.length === 0) rootNames = [targetFile];
  // 复用同 tsconfig 的旧 host 状态（SourceFile 缓存），否则 oldProgram 复用
  // 会拿旧文本算诊断（实测：全新 host + oldProgram → TS 整体沿用旧文件数组）。
  const hostState: PersistentHostState = old?.hostState ?? { compilerOptions, files: new Map() };
  hostState.compilerOptions = compilerOptions;
  const program = ts.createProgram({
    rootNames,
    options: compilerOptions,
    host: createHost(hostState),
    oldProgram: old?.program,
  });
  return { program, hostState };
}

/** 供测试清缓存。 */
export function resetTsProgramCache(): void {
  programCache.clear();
}

/** 单条 TS 诊断 → LSP 形（供 ledger/deferred 通道复用）。 */
function toLspDiagnostic(diagnostic: ts.Diagnostic): LspDiagnostic {
  const { line, character } =
    diagnostic.file && diagnostic.start !== undefined
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      : { line: 0, character: 0 };
  return {
    range: {
      start: { line, character },
      end: { line, character: character + (diagnostic.length ?? 0) },
    },
    severity:
      diagnostic.category === ts.DiagnosticCategory.Error
        ? 1
        : diagnostic.category === ts.DiagnosticCategory.Warning
          ? 2
          : 3,
    code: diagnostic.code,
    source: "ts",
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  };
}

/**
 * 对单个 .ts/.tsx 文件跑进程内语义诊断。增量复用同 tsconfig 的 Program+host；
 * 诊断只取目标文件。失败上抛，绝不折叠成「无诊断」的干净结果。
 */
export function runInProcessTsDiagnostics(absolutePath: string, cwd: string): FileDiagnosticsResult {
  const resolved = path.resolve(absolutePath);
  const tsconfigPath = findTsconfig(path.dirname(resolved));
  const cacheKey = tsconfigPath ?? path.dirname(resolved);
  const old = programCache.get(cacheKey);
  const cached = buildProgram(tsconfigPath, resolved, old);
  programCache.set(cacheKey, cached);

  const sourceFile = cached.program.getSourceFile(resolved);
  if (sourceFile === undefined) {
    throw new Error(`typescript: source file missing from program: ${resolved}`);
  }

  const diagnostics = [
    ...cached.program.getSyntacticDiagnostics(sourceFile),
    ...cached.program.getSemanticDiagnostics(sourceFile),
  ];

  const relPath = formatPathRelativeToCwd(resolved, cwd);
  if (diagnostics.length === 0) {
    return { server: IN_PROCESS_SERVER_NAME, messages: [], summary: "no issues", errored: false };
  }

  const lspDiagnostics = diagnostics.map((d) => toLspDiagnostic(d));
  const messages = lspDiagnostics.map((d) => {
    const line = d.range.start.line + 1;
    const col = d.range.start.character + 1;
    const code = d.code !== undefined ? ` (${d.code})` : "";
    return `${relPath}:${line}:${col} [${d.severity === 1 ? "error" : "warning"}] ${d.message}${code}`;
  });

  return {
    server: IN_PROCESS_SERVER_NAME,
    messages: limitDiagnosticMessages(messages),
    summary: formatDiagnosticsSummary(lspDiagnostics),
    errored: lspDiagnostics.some((d) => d.severity === 1),
  };
}

/** 是否本模块可处理的扩展名。 */
export function isTsDiagnosticTarget(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".ts" || ext === ".tsx";
}
