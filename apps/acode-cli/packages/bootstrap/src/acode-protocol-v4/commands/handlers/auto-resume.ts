// /auto-resume 命令组（specs/turn-auto-resume.md「命令面」）：desktop 经 v4/command
// handler leaf 复用 core 的命令模块（解析 + 回执随 locale 的单一实现住 core——
// bootstrap 不得反向依赖 cli）。协议面：payload = { args?: string }（原始子命令文本），
// result variant = { type: "autoResume", response: string }（编排者已落 shared schema，
// NATIVE_HANDLERS 注册同）。解析失败走 failed ACK（reasonCode 原样上行，message 即
// 用户可读用法文本）；其余回执一律 accepted + response。
import {
  createAutoResumeCommandHost,
  handleAutoResumeCommand,
  parseAutoResumeCommand,
} from "@acode/core";
import type { CommandEnvelope, CommandResult } from "@acode/shared/acode-protocol-v4";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";

/** 解析失败：failed ACK 的 message 即用户可读的用法/错误文本（gateway 原样上行）。 */
class V4AutoResumeInvalidArgsError extends Error {
  readonly reasonCode = "guard.autoResume.invalidArgs";
}

async function autoResumeCommand(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  const payload = envelope.payload as { args?: unknown } | undefined;
  const args = typeof payload?.args === "string" ? payload.args : "";
  const parsed = parseAutoResumeCommand(args);
  if (!parsed.ok) {
    throw new V4AutoResumeInvalidArgsError(parsed.error ?? "Invalid /auto-resume arguments");
  }
  const result = await handleAutoResumeCommand(args, createAutoResumeCommandHost(record.app));
  host.logger?.info?.("auto-resume command applied", {
    command: parsed.intent.kind,
    sessionId: record.app.sessionId,
  });
  return { type: "autoResume", response: result.response };
}

export const autoResumeHandlers = { autoResumeCommand };
