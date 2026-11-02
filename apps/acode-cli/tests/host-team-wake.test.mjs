// 宿主团队唤醒宿主/core 侧验收（apps/acode-cli/specs/host-team-wake.md 验收场景 1/2/4/7/8）。
// 覆盖：wakePending 形状收窄与 emptiness guard、空闲注入/忙碌留箱去重、世代去重（重放不二次
// 派工）、防循环上限、已停止队长不注入不报错、enabled:false 全关、注入文案的信任边界（R6，
// 含负向断言：不内联成员原文）。固定时钟 + 内存态隔离（EI-121）。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  MAX_WAKE_EVENTS,
  resolveTeamWakeConfig,
} from "../packages/core/src/runtime/team-wake/types.ts";
import {
  TeamWakeOwner,
  parseTeamWakeIntents,
} from "../packages/core/src/runtime/team-wake/owner.ts";
import { buildTeamWakeCommandText } from "../packages/core/src/runtime/team-wake/injector.ts";
import { formatIncomingMessage } from "../packages/core/src/system-reminder/incoming-message.ts";
import { RuntimeInputPresentationSchema } from "../packages/contracts/src/index.ts";

const AGENT_TEAMS_ID = "agent-teams@acode-plugins-official";
const CAPTAIN = "sess_captain";
const TEAM = "team-alpha";
const T0 = 1_700_000_000_000;

function messageFact(overrides = {}) {
  return {
    messageId: "msg-1",
    from: "alice",
    kind: "question",
    deliveredAt: "2026-11-02T00:00:00.000Z",
    ...overrides,
  };
}

function settledTaskFact(overrides = {}) {
  return {
    taskId: "task-1",
    owner: "bob",
    status: "done",
    at: "2026-11-02T00:00:01.000Z",
    ...overrides,
  };
}

function wakePending(overrides = {}) {
  return {
    generation: 5,
    captainSessionId: CAPTAIN,
    messages: [messageFact()],
    settledTasks: [],
    triggers: ["message", "question"],
    counts: { unreadMessages: 1, unsettledMemberTasks: 0 },
    ...overrides,
  };
}

function panelState(overrides = {}) {
  return {
    v: 1,
    teamId: TEAM,
    captainSessionId: CAPTAIN,
    wakePending: wakePending(),
    ...overrides,
  };
}

function notification(state) {
  return { pluginId: AGENT_TEAMS_ID, key: "agent-teams", state };
}

// 插件对同一团队在顶层与其 teams[] 条目上携带同一 wakePending（spec「主快照与 teams[] 各自
// 产出候选」）→ 一次通知产出 2 条同世代、同事实的镜像 intent。
function mirrorState(generation = 5) {
  const entry = {
    v: 1,
    teamId: TEAM,
    captainSessionId: CAPTAIN,
    wakePending: wakePending({ generation }),
  };
  return { ...entry, teams: [entry] };
}

function createOwner(configOverrides) {
  let nowMs = T0;
  const config = resolveTeamWakeConfig(configOverrides);
  const owner = new TeamWakeOwner({ getConfig: () => config, now: () => nowMs });
  return { advance: (ms) => (nowMs += ms), config, owner };
}

function firstIntent(state = panelState()) {
  const intents = parseTeamWakeIntents(state, T0);
  assert.equal(intents.length, 1);
  return intents[0];
}

// ── 验收 1/8：wakePending 形状收窄 + emptiness guard ──
describe("parseTeamWakeIntents - 形状收窄与 emptiness guard", () => {
  it("从主快照的 wakePending 解析出结构化 intent（不含成员原文）", () => {
    const intent = firstIntent();
    assert.equal(intent.teamId, TEAM);
    assert.equal(intent.generation, 5);
    assert.equal(intent.captainSessionId, CAPTAIN);
    assert.deepEqual(intent.messages, [
      {
        messageId: "msg-1",
        from: "alice",
        kind: "question",
        deliveredAt: "2026-11-02T00:00:00.000Z",
      },
    ]);
    assert.deepEqual(intent.triggers, ["message", "question"]);
    assert.equal(intent.counts.unreadMessages, 1);
    assert.equal(intent.truncated, false);
    // 负向：消息里的旁路字段（原文/任意载荷）不进 intent。
    assert.equal("body" in intent.messages[0], false);
  });

  it("wakePending 缺席 → 零行为（无 intent）", () => {
    assert.deepEqual(parseTeamWakeIntents({ teamId: TEAM, captainSessionId: CAPTAIN }, T0), []);
  });

  it("wakeSeq 因成员↔成员投递递增但无队长相关事实 → 不产 intent（emptiness guard）", () => {
    // 插件对任意成员来源投递（含成员↔成员）都递增 wakeSeq；若该世代没有队长未读消息/
    // 成员终态事实，wakePending 的 messages/settledTasks/triggers 为空 → 宿主零行为。
    const bumpedOnly = panelState({
      wakePending: {
        generation: 11,
        captainSessionId: CAPTAIN,
        messages: [],
        settledTasks: [],
        triggers: [],
        counts: { unreadMessages: 0, unsettledMemberTasks: 0 },
      },
    });
    assert.deepEqual(parseTeamWakeIntents(bumpedOnly, T0), []);
  });

  it("触发集空 / 事实空 → emptiness guard 吃掉（跨进程时序竞态幂等）", () => {
    const emptyTriggers = panelState({ wakePending: wakePending({ triggers: [] }) });
    const emptyFacts = panelState({
      wakePending: wakePending({ messages: [], settledTasks: [], triggers: ["settled_task"] }),
    });
    assert.deepEqual(parseTeamWakeIntents(emptyTriggers, T0), []);
    assert.deepEqual(parseTeamWakeIntents(emptyFacts, T0), []);
  });

  it("messages/settledTasks 超 MAX_WAKE_EVENTS 时截断并置 truncated（EI-9）", () => {
    const many = Array.from({ length: MAX_WAKE_EVENTS + 4 }, (_, index) =>
      messageFact({ messageId: `msg-${index}` }),
    );
    const [intent] = parseTeamWakeIntents(
      panelState({ wakePending: wakePending({ messages: many }) }),
      T0,
    );
    assert.equal(intent.messages.length, MAX_WAKE_EVENTS);
    assert.equal(intent.truncated, true);
  });

  it("嵌套 teams[] 的 wakePending 同样产出候选", () => {
    const state = {
      v: 1,
      teamId: TEAM,
      captainSessionId: CAPTAIN,
      teams: [panelState({ teamId: "team-beta", wakePending: wakePending({ generation: 7 }) })],
    };
    const intents = parseTeamWakeIntents(state, T0);
    assert.equal(intents.length, 1);
    assert.equal(intents[0].teamId, "team-beta");
    assert.equal(intents[0].generation, 7);
  });

  it("形状不符（非法 kind/status）逐条丢弃", () => {
    const [intent] = parseTeamWakeIntents(
      panelState({
        wakePending: wakePending({
          messages: [messageFact({ kind: "bogus" }), messageFact({ messageId: "msg-2" })],
          settledTasks: [settledTaskFact({ status: "weird" })],
        }),
      }),
      T0,
    );
    assert.deepEqual(
      intent.messages.map((message) => message.messageId),
      ["msg-2"],
    );
    assert.deepEqual(intent.settledTasks, []);
  });
});

// ── 验收 1/2：空闲注入、忙碌留箱去重 ──
describe("TeamWakeOwner - 空闲注入与忙碌留箱去重", () => {
  it("空闲：首次 intent 产出注入计划（enqueued）", () => {
    const { owner } = createOwner();
    const decision = owner.applyIntent(firstIntent());
    assert.equal(decision.kind, "enqueued");
    assert.equal(decision.plan.messages.length, 1);
    assert.deepEqual(decision.plan.triggers, ["message", "question"]);
    assert.equal(owner.hasPending(TEAM), true);
  });

  it("忙碌：同队命令未消费前重复通知不产生第二次派工", () => {
    const { owner } = createOwner();
    assert.equal(owner.applyIntent(firstIntent()).kind, "enqueued");
    const second = owner.applyIntent(firstIntent());
    assert.equal(second.kind, "skipped");
    assert.equal(second.reason, "duplicate_pending");
  });

  it("回合后投递：completeDelivery 计入 ack（consume-on-inject），同事实不再注入", () => {
    const { owner } = createOwner();
    owner.applyIntent(firstIntent());
    owner.completeDelivery({
      generation: 5,
      messageIds: ["msg-1"],
      settledTaskIds: [],
      teamId: TEAM,
    });
    assert.equal(owner.isDelivered(TEAM, "msg-1"), true);
    const repeat = owner.applyIntent(firstIntent());
    assert.equal(repeat.kind, "skipped");
    assert.equal(repeat.reason, "empty");
  });
});

// ── 回归：插件镜像双 intent（顶层 + teams[]）不提前耗尽 delivery attempts ──
describe("TeamWakeOwner - 镜像双 intent 与忙碌期重复通知", () => {
  it("一次通知的 2 条镜像 intent 只入队 1 条，重复通知不耗 delivery 上限", () => {
    const { owner } = createOwner({ maxDeliveryAttempts: 3 });
    let enqueued = 0;
    let duplicate = 0;
    // 队长忙碌：连续 6 次通知（每次 2 条镜像 intent），中间无 drain/ack。
    for (let round = 0; round < 6; round += 1) {
      const intents = parseTeamWakeIntents(mirrorState(5), T0);
      assert.equal(intents.length, 2, "mirrored wakePending must yield 2 intents");
      for (const intent of intents) {
        const decision = owner.applyIntent(intent);
        if (decision.kind === "enqueued") enqueued += 1;
        else if (decision.reason === "duplicate_pending") duplicate += 1;
        else assert.fail(`unexpected decision: ${JSON.stringify(decision)}`);
      }
    }
    assert.equal(enqueued, 1, "mirrored/repeated notifications must enqueue exactly once");
    assert.equal(duplicate, 11);
    assert.equal(owner.hasPending(TEAM), true);
  });

  it("忙碌期重复通知后，回合结束仍投递一次且不产生第二次派工", () => {
    const { owner } = createOwner({ maxDeliveryAttempts: 3 });
    for (let round = 0; round < 6; round += 1) {
      for (const intent of parseTeamWakeIntents(mirrorState(5), T0)) owner.applyIntent(intent);
    }
    owner.completeDelivery({
      generation: 5,
      messageIds: ["msg-1"],
      settledTaskIds: [],
      teamId: TEAM,
    });
    // 重放同一镜像帧：事实已 ack → 两条都 empty（无第二次派工）。
    for (const intent of parseTeamWakeIntents(mirrorState(5), T0)) {
      const decision = owner.applyIntent(intent);
      assert.deepEqual(decision, {
        kind: "skipped",
        reason: "empty",
        teamId: TEAM,
        generation: 5,
      });
    }
  });
});

// ── 验收 4：世代去重（重放不二次派工） ──
describe("TeamWakeOwner - 世代去重", () => {
  it("旧世代 intent 丢弃（EI-59）", () => {
    const { owner } = createOwner();
    owner.applyIntent(firstIntent(panelState({ wakePending: wakePending({ generation: 9 }) })));
    owner.completeDelivery({
      generation: 9,
      messageIds: ["msg-1"],
      settledTaskIds: [],
      teamId: TEAM,
    });
    const stale = owner.applyIntent(
      parseTeamWakeIntents(
        panelState({
          wakePending: wakePending({
            generation: 7,
            messages: [messageFact({ messageId: "msg-old" })],
          }),
        }),
        T0,
      )[0],
    );
    assert.equal(stale.kind, "skipped");
    assert.equal(stale.reason, "stale_generation");
  });

  it("邮箱已读重放（同一快照）不二次派工；未读仍在至多一次", () => {
    const { owner } = createOwner();
    owner.applyIntent(firstIntent());
    owner.completeDelivery({
      generation: 5,
      messageIds: ["msg-1"],
      settledTaskIds: [],
      teamId: TEAM,
    });
    // 重放同一帧：事实已 ack → 无注入。
    assert.deepEqual(
      owner.applyIntent(firstIntent()),
      { kind: "skipped", reason: "empty", teamId: TEAM, generation: 5 },
    );
  });
});

// ── 验收 8：防循环上限 / TTL / 逃生阀 ──
describe("TeamWakeOwner - 防循环上限与逃生阀", () => {
  it("MAX_WAKE_PROMPTS 越限后不再注入且置 prompts_exhausted hint", () => {
    const { owner } = createOwner({ maxWakePrompts: 2 });
    // 同一 messageId 在两次未交付的旨意里各计一次；第 3 次越限。
    for (const generation of [1, 2]) {
      const intent = parseTeamWakeIntents(
        panelState({ wakePending: wakePending({ generation }) }),
        T0,
      )[0];
      assert.equal(owner.applyIntent(intent).kind, "enqueued");
      owner.dropPending(TEAM); // 模拟 drain 失败/命令被丢弃（未计 ack）
    }
    const third = parseTeamWakeIntents(
      panelState({ wakePending: wakePending({ generation: 3 }) }),
      T0,
    )[0];
    const decision = owner.applyIntent(third);
    assert.equal(decision.kind, "skipped");
    assert.equal(decision.reason, "prompts_exhausted");
    assert.equal(owner.wakePromptCount(TEAM, "msg-1"), 2);
  });

  it("MAX_WAKE_DELIVERY_ATTEMPTS：同一 intent 真实重排（入队）超上限 → delivery_exhausted", () => {
    // maxWakePrompts 抬高，隔离出 delivery attempt 语义（不然同一 messageId 先撞 prompts 上限）。
    const { owner } = createOwner({ maxDeliveryAttempts: 3, maxWakePrompts: 10 });
    // delivery attempt 只在真正入队时递增：命令被丢弃（dropPending）后同世代再入队才计一次。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal(owner.applyIntent(firstIntent()).kind, "enqueued");
      owner.dropPending(TEAM); // 模拟 drain 失败/世代失效后的重排
    }
    const last = owner.applyIntent(firstIntent());
    assert.equal(last.kind, "skipped");
    assert.equal(last.reason, "delivery_exhausted");
    assert.equal(owner.hasPending(TEAM), false);
  });

  it("忙碌期同世代重复通知不计入 delivery attempt（不提前耗尽）", () => {
    const { owner } = createOwner({ maxDeliveryAttempts: 3 });
    assert.equal(owner.applyIntent(firstIntent()).kind, "enqueued");
    for (let index = 0; index < 20; index += 1) {
      const decision = owner.applyIntent(firstIntent());
      assert.equal(decision.kind, "skipped");
      assert.equal(decision.reason, "duplicate_pending");
    }
    assert.equal(owner.hasPending(TEAM), true);
  });

  it("WAKE_INTENT_TTL_MS：超过 TTL 的化石 intent 丢弃（EI-11）", () => {
    const { advance, owner } = createOwner({ intentTtlMs: 1000 });
    advance(1001);
    const decision = owner.applyIntent(firstIntent());
    assert.equal(decision.kind, "skipped");
    assert.equal(decision.reason, "expired");
  });

  it("enabled:false 全关：不注入、不报错", () => {
    const { owner } = createOwner({ enabled: false });
    const decision = owner.applyIntent(firstIntent());
    assert.equal(decision.kind, "skipped");
    assert.equal(decision.reason, "disabled");
    assert.equal(owner.hasPending(TEAM), false);
  });
});

// ── 验收 1/8：注入文案的信任边界（R6，含负向断言） ──
describe("buildTeamWakeCommandText - 信任边界与结构事实", () => {
  it("只带结构化事实：teamId / triggers / messageIds / taskIds，不内联成员原文", () => {
    const intent = parseTeamWakeIntents(
      panelState({
        wakePending: wakePending({
          messages: [{ ...messageFact(), body: "SECRET_MEMBER_BODY", from: "BAD Name<script>" }],
          settledTasks: [settledTaskFact()],
          triggers: ["message", "question", "settled_task"],
        }),
      }),
      T0,
    )[0];
    const { owner } = createOwner();
    const decision = owner.applyIntent(intent);
    const text = buildTeamWakeCommandText(decision.plan);
    assert.match(text, new RegExp(TEAM));
    assert.match(text, /Triggers: .*message/);
    assert.match(text, /msg-1/);
    assert.match(text, /task-1/);
    assert.match(text, /agent_teams_status/);
    // 负向：原文不进注入；非法成员名（可携带载荷）被丢弃。
    assert.equal(text.includes("SECRET_MEMBER_BODY"), false);
    assert.equal(text.includes("<script>"), false);
    assert.equal(text.includes("<system-reminder>"), false);
  });
});

// ── 验收 1：team_wake presentation 三段信任声明 + 接收端穷举 ──
describe("formatIncomingMessage - team_wake 信任声明", () => {
  it("沿用 TASK_NOTIFICATION_PREFIX 三段形状（否定声明 / 无真人输入 / 正向识别判据）", () => {
    const text = formatIncomingMessage("Host team-wake event.", "team_wake");
    assert.match(text, /\[SYSTEM NOTIFICATION - NOT USER INPUT\]/);
    assert.match(text, /automated team-orchestration event, NOT a message from the user/);
    assert.match(text, /No human input has been received since the last genuine user message/);
    assert.match(text, /Genuine-event criterion/);
    assert.match(text, /Host team-wake event\./);
  });

  it("接收端穷举：RuntimeInputPresentation 每个值都有 dispatch 分支（EI-21）", () => {
    for (const presentation of RuntimeInputPresentationSchema.options) {
      assert.doesNotThrow(
        () => formatIncomingMessage("body", presentation),
        `missing formatting branch for ${presentation}`,
      );
    }
    assert.equal(RuntimeInputPresentationSchema.options.includes("team_wake"), true);
  });
});

// ── bootstrap 派生：路由 / 已停止队长 / 逃生阀 / 重放（R4/R8/R9） ──
describe("bootstrap team-wake 派生", () => {
  it("命中队长 runtime → 派发 intent；未命中（队长已停止）→ 不注入不报错", async () => {
    const derivation = await import("../packages/bootstrap/src/team-wake-derivation.ts");
    const received = [];
    const dispatched = derivation.applyTeamWakeFromNotification({
      notification: notification(panelState()),
      enabled: true,
      lookupRuntime: (captainSessionId) =>
        captainSessionId === CAPTAIN ? { applyTeamWakeIntent: (intent) => received.push(intent) } : undefined,
      nowMs: T0,
      sessionId: CAPTAIN,
    });
    assert.equal(received.length, 1);
    assert.equal(dispatched.length, 1);

    // 队长已停止：lookup 返回 undefined → 无派发、无异常。
    assert.doesNotThrow(() =>
      derivation.applyTeamWakeFromNotification({
        notification: notification(panelState()),
        enabled: true,
        lookupRuntime: () => undefined,
        nowMs: T0,
        sessionId: CAPTAIN,
      }),
    );
  });

  it("非队长会话（captainSessionId 不命中）不注入", async () => {
    const derivation = await import("../packages/bootstrap/src/team-wake-derivation.ts");
    const received = [];
    derivation.applyTeamWakeFromNotification({
      notification: notification(panelState()),
      enabled: true,
      lookupRuntime: (captainSessionId) =>
        captainSessionId === "sess_other" ? { applyTeamWakeIntent: (intent) => received.push(intent) } : undefined,
      nowMs: T0,
      sessionId: "sess_member",
    });
    assert.equal(received.length, 0);
  });

  it("enabled:false 全关：通知到达零行为", async () => {
    const derivation = await import("../packages/bootstrap/src/team-wake-derivation.ts");
    const received = [];
    const dispatched = derivation.applyTeamWakeFromNotification({
      notification: notification(panelState()),
      enabled: false,
      lookupRuntime: () => ({ applyTeamWakeIntent: (intent) => received.push(intent) }),
      nowMs: T0,
      sessionId: CAPTAIN,
    });
    assert.deepEqual(dispatched, []);
    assert.equal(received.length, 0);
  });

  it("wakePending 缺席 → 零行为", async () => {
    const derivation = await import("../packages/bootstrap/src/team-wake-derivation.ts");
    const received = [];
    derivation.applyTeamWakeFromNotification({
      notification: notification({ teamId: TEAM, captainSessionId: CAPTAIN }),
      enabled: true,
      lookupRuntime: () => ({ applyTeamWakeIntent: (intent) => received.push(intent) }),
      nowMs: T0,
      sessionId: CAPTAIN,
    });
    assert.equal(received.length, 0);
  });

  it("重放：按最后一条 PluginStateUpdated 重派；无事件 → 零行为", async () => {
    const derivation = await import("../packages/bootstrap/src/team-wake-derivation.ts");
    const { SessionEventType } = await import("../packages/contracts/src/index.ts");
    const received = [];
    const events = [
      {
        payload: { key: "agent-teams", pluginId: AGENT_TEAMS_ID, state: panelState() },
        type: SessionEventType.PluginStateUpdated,
      },
    ];
    derivation.redispatchTeamWakeFromEvents({
      enabled: true,
      events,
      lookupRuntime: () => ({ applyTeamWakeIntent: (intent) => received.push(intent) }),
      nowMs: T0,
      sessionId: CAPTAIN,
    });
    assert.equal(received.length, 1);

    derivation.redispatchTeamWakeFromEvents({
      enabled: true,
      events: [],
      lookupRuntime: () => ({ applyTeamWakeIntent: (intent) => received.push(intent) }),
      nowMs: T0,
      sessionId: CAPTAIN,
    });
    assert.equal(received.length, 1);
  });
});

// ── 验收 8 负向组：core team-wake 无 CommandInbox / MCP / 插件状态目录引用（EI-120） ──
describe("core team-wake 模块负向组", () => {
  it("不引用 CommandInbox / MCP 通知 / 插件状态目录 / 插件包", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const moduleDir = join(here, "../packages/core/src/runtime/team-wake");
    const files = ["types.ts", "owner.ts", "injector.ts", "runtime-api.ts"];
    const forbidden = [
      "CommandInbox",
      "command-inbox",
      "notifications/message",
      "@modelcontextprotocol",
      "AGENT_TEAMS_STATE_DIR",
      ".agent-teams",
      "agent-teams-plugin",
    ];
    for (const file of files) {
      const source = await readFile(join(moduleDir, file), "utf8");
      // 只查代码面（剥掉注释）：注释里说明「不经 CommandInbox」是契约陈述，不是依赖。
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      for (const needle of forbidden) {
        assert.equal(
          code.includes(needle),
          false,
          `${file} must not reference ${needle}`,
        );
      }
    }
  });
});