/* off-peak mock 网关的 E2E scenario 脚本与伪 Anthropic 响应构造：
   foreground-subagents/capture 的请求分类、剧本应答与非流式/SSE 响应序列化。
   原为 offPeakMockGateway.ts 模块级实现；纯函数无状态，拆分后与票据状态叶子解耦。 */
import type { ServerResponse } from "node:http";

/** 仅供确定性 E2E 使用的 messages 脚本名；生产与普通 mock 演示均不设置。 */
export type OffPeakMockScenarioName = "foreground-subagents" | "capture" | "invalid-ticket";

export const FOREGROUND_SUBAGENT_SCENARIO = {
  parentMarker: "E2E_OFFPEAK_SUBAGENTS_PARENT",
  parentFinal: "E2E_OFFPEAK_SUBAGENTS_PARENT_OK",
  backgroundError:
    "Idle-time tasks do not support background agents. Run this agent in the foreground.",
  children: [
    {
      stage: "child-explore",
      marker: "E2E_OFFPEAK_SUBAGENT_CHILD_EXPLORE",
      reply: "E2E_OFFPEAK_SUBAGENT_CHILD_EXPLORE_OK",
      toolId: "toolu_e2e_offpeak_explore",
      input: {
        description: "Verify Explore foreground inheritance",
        prompt:
          "E2E_OFFPEAK_SUBAGENT_CHILD_EXPLORE: reply exactly E2E_OFFPEAK_SUBAGENT_CHILD_EXPLORE_OK.",
        subagent_type: "Explore",
      },
    },
    {
      stage: "child-general-purpose",
      marker: "E2E_OFFPEAK_SUBAGENT_CHILD_GENERAL",
      reply: "E2E_OFFPEAK_SUBAGENT_CHILD_GENERAL_OK",
      toolId: "toolu_e2e_offpeak_general",
      input: {
        description: "Verify general-purpose foreground inheritance",
        prompt:
          "E2E_OFFPEAK_SUBAGENT_CHILD_GENERAL: reply exactly E2E_OFFPEAK_SUBAGENT_CHILD_GENERAL_OK.",
        subagent_type: "general-purpose",
      },
    },
    {
      stage: "child-code-search",
      marker: "E2E_OFFPEAK_SUBAGENT_CHILD_CODE_SEARCH",
      reply: "E2E_OFFPEAK_SUBAGENT_CHILD_CODE_SEARCH_OK",
      toolId: "toolu_e2e_offpeak_code_search",
      input: {
        description: "Verify custom Code Search foreground inheritance",
        prompt:
          "E2E_OFFPEAK_SUBAGENT_CHILD_CODE_SEARCH: reply exactly E2E_OFFPEAK_SUBAGENT_CHILD_CODE_SEARCH_OK.",
        subagent_type: "Code Search",
      },
    },
    {
      stage: "child-custom-inherit",
      marker: "E2E_OFFPEAK_SUBAGENT_CHILD_INHERIT",
      reply: "E2E_OFFPEAK_SUBAGENT_CHILD_INHERIT_OK",
      toolId: "toolu_e2e_offpeak_inherit",
      input: {
        description: "Verify custom inherited-model foreground agent",
        prompt:
          "E2E_OFFPEAK_SUBAGENT_CHILD_INHERIT: reply exactly E2E_OFFPEAK_SUBAGENT_CHILD_INHERIT_OK.",
        subagent_type: "E2E OffPeak Inherit Reviewer",
      },
    },
  ],
  backgrounds: [
    {
      stage: "unexpected-background-explicit",
      marker: "E2E_OFFPEAK_SUBAGENT_BACKGROUND_EXPLICIT",
      toolId: "toolu_e2e_offpeak_background_explicit",
      input: {
        description: "Verify explicit background rejection",
        prompt:
          "E2E_OFFPEAK_SUBAGENT_BACKGROUND_EXPLICIT: this child must never reach the provider.",
        run_in_background: true,
        subagent_type: "general-purpose",
      },
    },
    {
      stage: "unexpected-background-profile",
      marker: "E2E_OFFPEAK_SUBAGENT_BACKGROUND_PROFILE",
      toolId: "toolu_e2e_offpeak_background_profile",
      input: {
        description: "Verify profile background rejection",
        prompt:
          "E2E_OFFPEAK_SUBAGENT_BACKGROUND_PROFILE: this child must never reach the provider.",
        subagent_type: "E2E OffPeak Background Reviewer",
      },
    },
  ],
} as const;

export function parseMockRequestJson(requestBody: Buffer): unknown {
  try {
    return JSON.parse(requestBody.toString("utf8"));
  } catch {
    return {};
  }
}

export function readRequestString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

export function readRequestNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

export function readRequestBoolean(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as Record<string, unknown>)[key] === true;
}

export function classifyForegroundSubagentScenarioRequest(requestJson: unknown): string {
  const serialized = JSON.stringify(requestJson);
  if (
    FOREGROUND_SUBAGENT_SCENARIO.children.every((child) => serialized.includes(child.reply)) &&
    serialized.includes(FOREGROUND_SUBAGENT_SCENARIO.backgroundError)
  ) {
    return "parent-continuation";
  }
  for (const child of FOREGROUND_SUBAGENT_SCENARIO.children) {
    if (serialized.includes(child.marker)) return child.stage;
  }
  for (const background of FOREGROUND_SUBAGENT_SCENARIO.backgrounds) {
    if (serialized.includes(background.marker)) return background.stage;
  }
  if (serialized.includes(FOREGROUND_SUBAGENT_SCENARIO.parentMarker)) {
    return "parent-initial";
  }
  return "unknown";
}

export function buildForegroundSubagentScenarioResponse(
  stage: string,
): AnthropicMockResponse | undefined {
  if (stage === "parent-initial") {
    return anthropicMockResponse({
      content: [
        ...FOREGROUND_SUBAGENT_SCENARIO.children.map((child) => ({
          type: "tool_use" as const,
          id: child.toolId,
          name: "Agent",
          input: child.input,
        })),
        ...FOREGROUND_SUBAGENT_SCENARIO.backgrounds.map((background) => ({
          type: "tool_use" as const,
          id: background.toolId,
          name: "Agent",
          input: background.input,
        })),
      ],
      stopReason: "tool_use",
    });
  }
  const child = FOREGROUND_SUBAGENT_SCENARIO.children.find(
    (candidate) => candidate.stage === stage,
  );
  if (child) {
    return anthropicMockResponse({
      content: [{ type: "text", text: child.reply }],
      stopReason: "end_turn",
    });
  }
  const background = FOREGROUND_SUBAGENT_SCENARIO.backgrounds.find(
    (candidate) => candidate.stage === stage,
  );
  if (background) {
    return anthropicMockResponse({
      content: [{ type: "text", text: `${background.marker}_UNEXPECTED` }],
      stopReason: "end_turn",
    });
  }
  if (stage === "parent-continuation") {
    return anthropicMockResponse({
      content: [{ type: "text", text: FOREGROUND_SUBAGENT_SCENARIO.parentFinal }],
      stopReason: "end_turn",
    });
  }
  return undefined;
}

export interface AnthropicMockResponse {
  content: readonly Record<string, unknown>[];
  id: string;
  model: string;
  role: "assistant";
  stop_reason: "end_turn" | "tool_use";
  type: "message";
  usage: { input_tokens: number; output_tokens: number };
}

export function anthropicMockResponse(input: {
  content: readonly Record<string, unknown>[];
  stopReason: "end_turn" | "tool_use";
}): AnthropicMockResponse {
  return {
    id: `msg_offpeak_mock_${input.stopReason}`,
    type: "message",
    role: "assistant",
    model: "offpeak-mock",
    stop_reason: input.stopReason,
    content: input.content,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

export function respondWithAnthropicMock(
  res: ServerResponse,
  response: AnthropicMockResponse,
  stream: boolean,
): void {
  if (!stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
    return;
  }

  const events: string[] = [
    anthropicSseEvent("message_start", {
      type: "message_start",
      message: { ...response, content: [], stop_reason: null },
    }),
  ];
  response.content.forEach((block, index) => {
    if (block.type === "tool_use") {
      events.push(
        anthropicSseEvent("content_block_start", {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: {},
          },
        }),
        anthropicSseEvent("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input ?? {}),
          },
        }),
        anthropicSseEvent("content_block_stop", {
          type: "content_block_stop",
          index,
        }),
      );
      return;
    }
    events.push(
      anthropicSseEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      }),
      anthropicSseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block.text ?? "" },
      }),
      anthropicSseEvent("content_block_stop", {
        type: "content_block_stop",
        index,
      }),
    );
  });
  events.push(
    anthropicSseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: response.stop_reason, stop_sequence: null },
      usage: response.usage,
    }),
    anthropicSseEvent("message_stop", { type: "message_stop" }),
  );
  res.writeHead(200, {
    "cache-control": "no-cache",
    "content-type": "text/event-stream; charset=utf-8",
  });
  res.end(events.join(""));
}

function anthropicSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
