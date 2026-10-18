// 熔断挂起字段的 wire 回归（apps/acode-cli/specs/mcp-lifecycle-ttl-approval.md R2.3）：
// CLI live status 原样透传 reconnectSuspension，此前 strict schema 拒收——熔断发生的
// 那一刻 mcp/list 整条命令抛 ZodError。本测试钉住「合法形态全保真 + 非法形态仍拒」。
import assert from "node:assert/strict";
import test from "node:test";
import { acodeMcpListResultSchema } from "../src/acode-protocol/index.js";

const BASE_SNAPSHOT = {
  transport: "stdio",
  toolCount: 0,
  updatedAt: "2026-10-18T12:00:00.000Z",
} as const;

test("connect_failures 挂起形态：parse 通过且字段完整保留（回归：此前 strict 拒收）", () => {
  const suspension = {
    consecutiveFailures: 3,
    suspendedAt: "2026-10-18T11:59:00.000Z",
    suspendedBy: "connect_failures",
  };
  const result = acodeMcpListResultSchema.parse({
    statuses: {
      srv: { ...BASE_SNAPSHOT, status: "failed", error: "boom", reconnectSuspension: suspension },
    },
  });
  assert.deepEqual(result.statuses["srv"]?.reconnectSuspension, suspension);
});

test("in_call_crashes 挂起形态：双计数字段保真", () => {
  const suspension = {
    consecutiveFailures: 0,
    consecutiveInCallCrashes: 3,
    suspendedAt: "2026-10-18T11:59:00.000Z",
    suspendedBy: "in_call_crashes",
  };
  const result = acodeMcpListResultSchema.parse({
    statuses: {
      srv: { ...BASE_SNAPSHOT, status: "disconnected", reconnectSuspension: suspension },
    },
  });
  assert.deepEqual(result.statuses["srv"]?.reconnectSuspension, suspension);
});

test("crash_storm 维度与 suspendedBy 缺失的历史形态均通过", () => {
  const storm = acodeMcpListResultSchema.parse({
    statuses: {
      srv: {
        ...BASE_SNAPSHOT,
        status: "disconnected",
        reconnectSuspension: {
          consecutiveFailures: 1,
          suspendedAt: "2026-10-18T11:59:00.000Z",
          suspendedBy: "crash_storm",
        },
      },
    },
  });
  assert.equal(storm.statuses["srv"]?.reconnectSuspension?.suspendedBy, "crash_storm");

  const legacy = acodeMcpListResultSchema.parse({
    statuses: {
      srv: {
        ...BASE_SNAPSHOT,
        status: "failed",
        reconnectSuspension: {
          consecutiveFailures: 3,
          suspendedAt: "2026-10-18T11:59:00.000Z",
        },
      },
    },
  });
  assert.equal(legacy.statuses["srv"]?.reconnectSuspension?.suspendedBy, undefined);
});

test("无挂起字段的快照不受影响（向后兼容）", () => {
  const result = acodeMcpListResultSchema.parse({
    statuses: { srv: { ...BASE_SNAPSHOT, status: "connected", toolCount: 4 } },
  });
  assert.equal(result.statuses["srv"]?.reconnectSuspension, undefined);
});

test("非法形态仍被拒：负计数 / suspendedBy 出集 / 多余键 / suspendedAt 空串", () => {
  assert.throws(() =>
    acodeMcpListResultSchema.parse({
      statuses: {
        srv: {
          ...BASE_SNAPSHOT,
          status: "failed",
          reconnectSuspension: {
            consecutiveFailures: -1,
            suspendedAt: "2026-10-18T11:59:00.000Z",
          },
        },
      },
    }),
  );
  assert.throws(() =>
    acodeMcpListResultSchema.parse({
      statuses: {
        srv: {
          ...BASE_SNAPSHOT,
          status: "failed",
          reconnectSuspension: {
            consecutiveFailures: 3,
            suspendedAt: "2026-10-18T11:59:00.000Z",
            suspendedBy: "budget_exhausted",
          },
        },
      },
    }),
  );
  assert.throws(() =>
    acodeMcpListResultSchema.parse({
      statuses: {
        srv: {
          ...BASE_SNAPSHOT,
          status: "failed",
          reconnectSuspension: {
            consecutiveFailures: 3,
            suspendedAt: "2026-10-18T11:59:00.000Z",
            windowCount: 7,
          },
        },
      },
    }),
  );
  assert.throws(() =>
    acodeMcpListResultSchema.parse({
      statuses: {
        srv: {
          ...BASE_SNAPSHOT,
          status: "failed",
          reconnectSuspension: { consecutiveFailures: 3, suspendedAt: "" },
        },
      },
    }),
  );
});
