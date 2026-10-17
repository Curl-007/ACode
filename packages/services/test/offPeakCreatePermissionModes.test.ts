import assert from "node:assert/strict";
import test from "node:test";
import type {
  ACodeOffPeakTaskCreateParams,
  ModelSelection,
  OffPeakCodingPlanSupport,
} from "@acode/shared";
import { OffPeakTaskService } from "../src/session/offPeakTaskService.js";
import type { OffPeakTaskRepo } from "../src/session/offPeakTaskRepo.js";
import type { OffPeakServerClient } from "../src/session/offPeakServerClient.js";
import type { ServiceLogger } from "../src/logger/serviceLogger.js";

// WI2-D 微收尾①配套：Off-peak 创建入口的权限档门（offPeakTaskService 的
// VALID_CREATE_PERMISSION_MODES，手写闭集）必须跟上 shared acodeTaskModeSchema
// 的 dontAsk 扩集（权限批 2 R1）——漏扩时表单选 dontAsk 保存会被误判
// client_validation 静默拒绝。判别手法：takeTicket 恒抛网络错，
// 通过档位门的请求落到 ticket_request/network，被档位门拒绝的落 client_validation。

const PRODUCT_MODES = ["build", "edit", "plan", "yolo", "dontAsk"] as const;

function createService(): OffPeakTaskService {
  const selection: ModelSelection = { providerId: "glm", modelId: "test-model" };
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as unknown as ServiceLogger;
  return new OffPeakTaskService({
    // repo/ticket client 在档位门之后才会被触达；takeTicket 恒抛错保证不落库。
    repo: {} as OffPeakTaskRepo,
    client: {
      takeTicket: async () => {
        throw new Error("simulated network down");
      },
    } as unknown as OffPeakServerClient,
    resolveCodingPlanSupport: async () =>
      ({ supported: false, reason: "connection_unselected" }) as OffPeakCodingPlanSupport,
    resolveTelemetryProviderName: async () => "",
    resolveModelSelection: async () => ({ ok: true as const, selection }),
    logger,
  });
}

function createParams(permissionMode: string): ACodeOffPeakTaskCreateParams {
  return {
    title: "nightly refactor",
    prompt: "run the nightly refactor",
    permissionMode: permissionMode as ACodeOffPeakTaskCreateParams["permissionMode"],
    modelSelection: { providerId: "glm", modelId: "test-model" },
    workspacePath: "/tmp/ws",
  };
}

test("产品五档（含 dontAsk）全部通过创建档位门", async () => {
  const service = createService();
  for (const mode of PRODUCT_MODES) {
    const result = await service.createTask(createParams(mode));
    assert.equal(result.ok, false);
    assert.equal(
      result.failureStage,
      "ticket_request",
      `permissionMode "${mode}" 未通过 VALID_CREATE_PERMISSION_MODES 档位门`,
    );
    assert.equal(result.errorCategory, "network");
  }
});

test("闭集外档位仍被 client_validation 拒绝（门未被放宽）", async () => {
  const service = createService();
  const result = await service.createTask(createParams("yolo-everything"));
  assert.equal(result.ok, false);
  assert.equal(result.failureStage, "client_validation");
  assert.equal(result.errorCategory, "client_validation");
});
