import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acodeInteractionOriginAncestorSchema,
  acodeInteractionRequestOriginSchema,
} from "../src/acode-protocol-legacy-types.js";

/**
 * origin 谱系协议 schema 的 additive 扩展验收
 * （apps/acode-cli/specs/subagent-interaction-origin-lineage.md R4 / 场景 6）：
 * depth≥2 新载荷通过、历史载荷（无新字段）原样通过、strict 拒非法祖先条目——
 * 校验面与 CLI contracts 的 SubagentInteractionRequestOrigin 字段一一对应。
 */

const flatOrigin = {
  kind: "subagent" as const,
  agentId: "agent_b",
  agentType: "general-purpose",
  childSessionId: "sess_subagent_agent_b",
  parentSessionId: "sess_subagent_agent_a",
};

test("历史载荷（无 ancestors/rootSessionId）原样通过——depth-1 缺省面回归", () => {
  const parsed = acodeInteractionRequestOriginSchema.parse(flatOrigin);
  assert.deepStrictEqual(parsed, flatOrigin);
});

test("depth≥2 载荷：ancestors + rootSessionId 通过且字段保全", () => {
  const full = {
    ...flatOrigin,
    ancestors: [
      {
        agentId: "agent_a",
        agentType: "general-purpose",
        sessionId: "sess_subagent_agent_a",
        parentSessionId: "sess_root",
        description: "probe a",
      },
    ],
    rootSessionId: "sess_root",
  };
  const parsed = acodeInteractionRequestOriginSchema.parse(full);
  assert.deepStrictEqual(parsed, full);
});

test("strict 拒绝：祖先条目缺 sessionId / 带未知字段 / 空 agentId", () => {
  assert.throws(() =>
    acodeInteractionRequestOriginSchema.parse({
      ...flatOrigin,
      ancestors: [
        { agentId: "agent_a", agentType: "general-purpose", parentSessionId: "sess_root" },
      ],
    }),
  );
  assert.throws(() =>
    acodeInteractionRequestOriginSchema.parse({
      ...flatOrigin,
      ancestors: [
        {
          agentId: "agent_a",
          agentType: "general-purpose",
          sessionId: "sess_subagent_agent_a",
          parentSessionId: "sess_root",
          smuggled: true,
        },
      ],
    }),
  );
  assert.throws(() =>
    acodeInteractionOriginAncestorSchema.parse({
      agentId: "",
      agentType: "general-purpose",
      sessionId: "sess_a",
      parentSessionId: "sess_root",
    }),
  );
});
