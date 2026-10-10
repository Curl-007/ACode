// 转录整形纯函数；由 runner.mjs 保留公开入口。
const TOOL_INPUT_CHARS = 1200;
const TOOL_RESULT_CHARS = 3000;

function truncate(text, max) {
  return text.length > max
    ? `${text.slice(0, max)}\n…[runner-truncated ${text.length - max} chars]`
    : text;
}

/**
 * 整形纯函数（spec §R3 映射表）：raw stream-json → judge 可读转录。
 * raw 流不可直送 judge（试点实证：2665/2808 行是 token delta，60k 截断预算被噪声
 * 吃满）——本函数是 runner 硬需求「转录整形」的唯一实现。乱行跳过不崩。
 */
export function shapeTranscript(ndjson) {
  const blocks = [];
  const textByMessage = new Map();
  let eventsTotal = 0;
  for (const line of ndjson.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // 半截行/非 JSON 噪声：跳过，不中断整形
    }
    eventsTotal += 1;
    const p = ev.payload ?? {};
    if (ev.type === "turn.started") {
      blocks.push(`[user] ${p.input}`);
    } else if (ev.type === "model.streaming") {
      if (p.kind === "text_delta") {
        textByMessage.set(
          p.assistantMessageId,
          (textByMessage.get(p.assistantMessageId) ?? "") + (p.delta ?? ""),
        );
      } else if (p.kind === "text_end") {
        const text = (textByMessage.get(p.assistantMessageId) ?? "").trim();
        if (text) blocks.push(`[assistant] ${text}`);
      } else if (p.kind === "tool_call") {
        blocks.push(
          `[tool call ${p.toolCallId}] ${p.toolName}\n${truncate(JSON.stringify(p.input, null, 1), TOOL_INPUT_CHARS)}`,
        );
      }
      // reasoning_*、start/finish、tool_input_* 等一律丢弃（§R3 映射表）
    } else if (ev.type === "tool.updated" && p.kind === "result") {
      const content =
        typeof p.result?.content === "string"
          ? p.result.content
          : JSON.stringify(p.result?.content ?? null);
      blocks.push(
        `[tool result ${p.toolCallId}] success=${p.result?.success} duration=${p.duration}ms\n${truncate(content ?? "", TOOL_RESULT_CHARS)}`,
      );
    } else if (ev.type === "result") {
      blocks.push(`[final assistant message] ${ev.response}`);
    }
  }
  const text = `${blocks.join("\n\n")}\n`;
  return { text, eventsTotal, blocksShaped: blocks.length, shapedChars: text.length };
}

/**
 * 子转录整形（spec §R3 子转录规则，EXP1 实证源）：子会话 rollout model-io jsonl 的
 * **末行** `request.body.messages` 是完整消息链（含全部 tool_use/tool_result）；映射为
 * 与父转录同族的块，末尾追加 output.txt 全文为 [final report]（报告契约面判分对象）。
 * system 不在 messages 里，天然丢弃。
 */
export function shapeChildTranscript(modelIoNdjson, finalReport) {
  let last;
  for (const line of modelIoNdjson.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      last = JSON.parse(line);
    } catch {
      continue;
    }
  }
  const messages = last?.request?.body?.messages ?? [];
  const blocks = [];
  for (const msg of messages) {
    const parts =
      typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : (msg.content ?? []);
    for (const part of parts) {
      if (part.type === "text" && msg.role === "user") {
        blocks.push(`[user] ${part.text}`);
      } else if (part.type === "text" && msg.role === "assistant") {
        blocks.push(`[assistant] ${part.text}`);
      } else if (part.type === "tool_use") {
        blocks.push(
          `[tool call ${part.id}] ${part.name}\n${truncate(JSON.stringify(part.input ?? {}, null, 1), TOOL_INPUT_CHARS)}`,
        );
      } else if (part.type === "tool_result") {
        const content =
          typeof part.content === "string" ? part.content : JSON.stringify(part.content ?? "");
        blocks.push(`[tool result ${part.tool_use_id}]\n${truncate(content, TOOL_RESULT_CHARS)}`);
      }
    }
  }
  if (finalReport?.trim()) blocks.push(`[final report] ${finalReport.trim()}`);
  const text = `${blocks.join("\n\n")}\n`;
  return { text, blocksShaped: blocks.length, shapedChars: text.length };
}
