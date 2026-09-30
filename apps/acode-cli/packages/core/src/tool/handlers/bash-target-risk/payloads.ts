// 不可见 payload 的处理：外方言 shell 与命令替换（J1-1）。
// 规格见 apps/acode-cli/specs/bash-target-blast-radius.md R4。
//
// 机制参照 jcode (MIT, github.com/1jehuang/jcode) crates/jcode-command-risk/src/lib.rs
// 的 shell/opaque 处理，自撰 TypeScript 实现。递归评估经注入的 ScriptAssessor 回调完成，
// 避免模块循环依赖。

import {
  BASE64_LIKE_PATTERN,
  isFlagToken,
  pushFinding,
  wrapperPayloadUnknown,
  type ScriptAssessor,
} from "./grammar.js";
import type { TargetRiskContext, TargetRiskFinding } from "./types.js";

const FOREIGN_DIALECT_REASON =
  "payload runs through a foreign shell dialect whose full semantics cannot be verified statically";

/** cmd/powershell/pwsh 的 payload：尽力递归评估 + 认不出的形态 confirm 兜底。 */
export function assessForeignShellPayload(
  name: string,
  args: readonly string[],
  context: TargetRiskContext,
  findings: TargetRiskFinding[],
  depth: number,
  assessScript: ScriptAssessor,
): void {
  const isCmd = name === "cmd" || name === "cmd.exe";
  if (isCmd) {
    const switchIndex = args.findIndex(
      (arg) => arg.toLowerCase() === "/c" || arg.toLowerCase() === "/k",
    );
    if (switchIndex === -1) {
      pushFinding(findings, wrapperPayloadUnknown(name));
      return;
    }
    const payload = args.slice(switchIndex + 1).join(" ");
    if (payload.trim().length > 0) assessScript(payload, context, findings, depth + 1);
    return;
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (/^-{1,2}e/i.test(arg) && BASE64_LIKE_PATTERN.test(args[i + 1] ?? "")) {
      pushFinding(findings, {
        level: "confirm",
        reason: "encoded shell payload cannot be identified statically",
      });
      return;
    }
    if (/^-{1,2}f(?:ile)?$/i.test(arg)) {
      pushFinding(findings, {
        level: "confirm",
        reason: "shell script file payload cannot be identified statically",
      });
      return;
    }
    if (/^(-{1,2}c(?:ommand)?|\/c)$/i.test(arg)) {
      const payload = args.slice(i + 1).join(" ");
      if (payload.trim().length > 0) assessScript(payload, context, findings, depth + 1);
      pushFinding(findings, { level: "confirm", reason: FOREIGN_DIALECT_REASON });
      return;
    }
  }
  const payload = args.filter((arg) => !isFlagToken(arg)).join(" ");
  if (payload.trim().length === 0) {
    pushFinding(findings, wrapperPayloadUnknown(name));
    return;
  }
  assessScript(payload, context, findings, depth + 1);
  pushFinding(findings, { level: "confirm", reason: FOREIGN_DIALECT_REASON });
}

/**
 * 提取命令替换内层文本：`$(…)`（括号配平、引号感知）、反引号对、`<(…)`/`>(…)`。
 * 内层命令在主命令之前执行，必须参与评估；外层含替换的目标本身按未解析处理。
 */
export function extractCommandSubstitutions(text: string): string[] {
  const scripts: string[] = [];
  let i = 0;
  while (i < text.length) {
    const pair = text.slice(i, i + 2);
    if (pair === "$(" || pair === "<(" || pair === ">(") {
      const end = findClosingParen(text, i + 1);
      if (end > i + 2) {
        scripts.push(text.slice(i + 2, end));
        i = end + 1;
        continue;
      }
      i += 2;
      continue;
    }
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        scripts.push(text.slice(i + 1, end));
        i = end + 1;
        continue;
      }
    }
    i += 1;
  }
  return scripts;
}

function findClosingParen(text: string, openIndex: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i]!;
    if (quote) {
      if (char === "\\") i += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
