import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// spec: packages/server/specs/ssh-host-key-trust.md 产品规则 8-9。
// Host 绑定 Electron parentPort，直接 import host/index.ts 会启动完整 Host runtime，
// 因此用源码不变量守护取消/迟到 challenge 的生命周期边界。
const hostSource = readFileSync(
  fileURLToPath(new URL("../src/host/index.ts", import.meta.url)),
  "utf8",
);

test("SSH challenge cancellation keeps a request tombstone until Host disposal", () => {
  const cancelBranch = hostSource.indexOf(
    "if (msg.type === HostMessageTypes.CancelRemoteWorkspaceConnect)",
  );
  assert.ok(cancelBranch >= 0, "Host 必须处理远程连接取消消息");

  const tombstoneWrite = hostSource.indexOf(
    "cancelledSSHHostKeyRequestIds.add(msg.requestId)",
    cancelBranch,
  );
  const registryCancel = hostSource.indexOf(
    "windowRemoteConnectionRegistry.cancelConnect(msg.requestId)",
    cancelBranch,
  );
  assert.ok(tombstoneWrite > cancelBranch, "取消必须先登记 requestId 墓碑");
  assert.ok(registryCancel > tombstoneWrite, "registry cancellation 必须在墓碑登记后执行");

  assert.match(
    hostSource,
    /if \(cancelledSSHHostKeyRequestIds\.has\(msg\.requestId\)\)[\s\S]*?不能复用/u,
    "已取消 requestId 必须拒绝复用，防止迟到 hostVerifier 复活 waiter",
  );
  assert.doesNotMatch(
    hostSource,
    /cancelledSSHHostKeyRequestIds\.delete\(msg\.requestId\)/u,
    "不能在顶层 connect then/catch 竞态结束时提前删除墓碑",
  );
  assert.match(
    hostSource,
    /cancelledSSHHostKeyRequestIds\.clear\(\)/u,
    "墓碑只能随 Host 生命周期释放",
  );
});

