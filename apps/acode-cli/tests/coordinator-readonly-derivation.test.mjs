// 宿主派生模块经 bootstrap 的 `@acode/core`（dist）消费 core 会话 store；测试必须读
// **同一个模块实例**，否则 store 出现两份（源码 vs dist）——故经同一 dist 入口取 store。
import assert from "node:assert/strict";
import { test } from "node:test";

const derivation = await import(
  "../packages/bootstrap/src/coordinator-readonly-derivation.ts"
);
const scope = await import("../packages/core/dist/index.js");
const { SessionEventType } = await import("../packages/contracts/src/index.ts");

// 官方实存 id = name@marketplace（插件发现 `id: name@marketplace`）。
const AGENT_TEAMS_ID = "agent-teams@acode-plugins-official";

function notification(state, pluginId = AGENT_TEAMS_ID) {
  return { pluginId, key: "agent-teams", state };
}

function pluginStateEvent(state, pluginId = AGENT_TEAMS_ID) {
  return {
    type: SessionEventType.PluginStateUpdated,
    payload: { pluginId, key: "agent-teams", state },
  };
}

// ── R5 逃生阀：插件 userConfig captainReadOnly（三级默认，仅显式 false 放开）──
test("R5 逃生阀：仅用户显式 captainReadOnly:false 放开，缺席按硬编码 true", () => {
  assert.equal(
    derivation.resolveCaptainReadOnlyEnabled([
      { name: "agent-teams", configuredOptions: { captainReadOnly: false } },
    ]),
    false,
    "显式关闭 → 放开",
  );
  assert.equal(
    derivation.resolveCaptainReadOnlyEnabled([
      { name: "agent-teams", configuredOptions: { captainReadOnly: true } },
    ]),
    true,
  );
  assert.equal(
    derivation.resolveCaptainReadOnlyEnabled([
      { name: "agent-teams", configuredOptions: {} },
    ]),
    true,
    "未配置 → 硬编码回落 true（施加预设）",
  );
  assert.equal(derivation.resolveCaptainReadOnlyEnabled([{ name: "agent-teams" }]), true);
  assert.equal(
    derivation.resolveCaptainReadOnlyEnabled([{ name: "other-plugin" }]),
    true,
    "agent-teams 不在场 → 回落 true",
  );
  assert.equal(derivation.resolveCaptainReadOnlyEnabled(undefined), true);
});

// ── R2.2 生效：通知到达即派生并写入本会话基准 ────────────────────────────────
test("R2.2 生效：agent-teams 状态通知把会话标记为队长；逃生阀放开则不施加", () => {
  const sid = "sess_derive_on";
  scope.clearAllSessionCoordinatorScopes();
  derivation.applyCoordinatorBasisFromNotification({
    notification: notification({ teams: [{ teamId: "t1", captainSessionId: sid }] }),
    sessionId: sid,
    enabled: true,
  });
  assert.ok(scope.snapshotSessionCoordinatorScope(sid), "已建立只读作用域");

  // 逃生阀放开：不施加（对比成对断言）
  const sid2 = "sess_derive_off";
  scope.clearAllSessionCoordinatorScopes();
  derivation.applyCoordinatorBasisFromNotification({
    notification: notification({ teams: [{ teamId: "t1", captainSessionId: sid2 }] }),
    sessionId: sid2,
    enabled: false,
  });
  assert.equal(scope.snapshotSessionCoordinatorScope(sid2), undefined, "captainReadOnly:false 不施加");

  // 非 agent-teams 通道 → no-op
  const sid3 = "sess_derive_other";
  scope.clearAllSessionCoordinatorScopes();
  derivation.applyCoordinatorBasisFromNotification({
    notification: { pluginId: "other", key: "agent-teams", state: { teams: [{ captainSessionId: sid3 }] } },
    sessionId: sid3,
    enabled: true,
  });
  assert.equal(scope.snapshotSessionCoordinatorScope(sid3), undefined);

  // 裸名身份（另一种 marketplace 形态）也命中
  const sid4 = "sess_derive_bare";
  scope.clearAllSessionCoordinatorScopes();
  derivation.applyCoordinatorBasisFromNotification({
    notification: notification({ teams: [{ teamId: "t1", captainSessionId: sid4 }] }, "agent-teams"),
    sessionId: sid4,
    enabled: true,
  });
  assert.ok(scope.snapshotSessionCoordinatorScope(sid4), "裸名身份命中");
});

// ── R4 粘性：已建立后接触到不可得状态 → 保持只读 + identity_missing ──────────
test("R4 粘性：已建立后不可得状态不解除，保持只读并标 identity_missing", () => {
  const sid = "sess_derive_sticky";
  scope.clearAllSessionCoordinatorScopes();
  derivation.applyCoordinatorBasisFromNotification({
    notification: notification({ teams: [{ teamId: "t1", captainSessionId: sid }] }),
    sessionId: sid,
    enabled: true,
  });
  // 形状损坏（非对象 / teams 非数组）→ 不可得
  derivation.applyCoordinatorBasisFromNotification({
    notification: notification(null),
    sessionId: sid,
    enabled: true,
  });
  const snapshot = scope.snapshotSessionCoordinatorScope(sid);
  assert.ok(snapshot, "粘性：不解除");
  assert.equal(snapshot.identityMissing, true);

  // 正向再确认（合法的 teams 命中）→ 清空 identity_missing
  derivation.applyCoordinatorBasisFromNotification({
    notification: notification({ teams: [{ teamId: "t1", captainSessionId: sid }] }),
    sessionId: sid,
    enabled: true,
  });
  assert.equal(scope.snapshotSessionCoordinatorScope(sid).identityMissing, undefined);
});

// ── R4.2 不猜：从未建立 + 不可得 → 不施加 ────────────────────────────────────
test("R4.2 不猜：未建立的会话接触不可得状态不被锁为只读", () => {
  const sid = "sess_derive_never";
  scope.clearAllSessionCoordinatorScopes();
  derivation.applyCoordinatorBasisFromNotification({
    notification: notification({ teams: [{ teamId: "t1", captainSessionId: "sess_other" }] }),
    sessionId: sid,
    enabled: true,
  });
  assert.equal(scope.snapshotSessionCoordinatorScope(sid), undefined, "teams 不命中 → 不施加");
});

// ── R2.5/Q3 恢复：按重放的 PluginStateUpdated 事件重建（取最后一条）──────────
test("R2.5 恢复：重放事件重建基准，取最后一条 agent-teams 状态", () => {
  const sid = "sess_resume_events";
  scope.clearAllSessionCoordinatorScopes();
  derivation.rebuildCoordinatorBasisFromEvents({
    events: [
      pluginStateEvent({ teams: [{ teamId: "t1", captainSessionId: "sess_old" }] }),
      pluginStateEvent({ teams: [{ teamId: "t1", captainSessionId: sid }] }),
    ],
    sessionId: sid,
    enabled: true,
  });
  assert.ok(scope.snapshotSessionCoordinatorScope(sid), "最后一条命中 → 只读");

  // 逃生阀放开 → 不重建
  const sid2 = "sess_resume_off";
  scope.clearAllSessionCoordinatorScopes();
  derivation.rebuildCoordinatorBasisFromEvents({
    events: [pluginStateEvent({ teams: [{ teamId: "t1", captainSessionId: sid2 }] })],
    sessionId: sid2,
    enabled: false,
  });
  assert.equal(scope.snapshotSessionCoordinatorScope(sid2), undefined);

  // 无匹配事件 → 不写入（维持既有，R4.1）
  const sid3 = "sess_resume_none";
  scope.clearAllSessionCoordinatorScopes();
  derivation.rebuildCoordinatorBasisFromEvents({
    events: [{ type: SessionEventType.SessionCreated, payload: {} }],
    sessionId: sid3,
    enabled: true,
  });
  assert.equal(scope.snapshotSessionCoordinatorScope(sid3), undefined);

  // 最后一条显示本会话不再是队长 → 解除
  const sid4 = "sess_resume_release";
  scope.clearAllSessionCoordinatorScopes();
  scope.setSessionCoordinatorBasis(sid4, true);
  derivation.rebuildCoordinatorBasisFromEvents({
    events: [
      pluginStateEvent({ teams: [{ teamId: "t1", captainSessionId: sid4 }] }),
      pluginStateEvent({ teams: [{ teamId: "t1", captainSessionId: "sess_new" }] }),
    ],
    sessionId: sid4,
    enabled: true,
  });
  assert.equal(scope.snapshotSessionCoordinatorScope(sid4), undefined);
});