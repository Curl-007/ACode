// 拆分依据：translate.ts 超 400 行架构上限。方法分发表（方法名 → services 入口处理器）
// 与 spec 附录一一对应，是「方法→services 入口」审计面的单一出处，独立成叶子后本表可整页审读。
import { randomUUID } from "node:crypto";
import type { ServiceCollection } from "@acode/services";
import { IACodeAgentService, IACodeTaskService, IFileService, IModelSelectionService } from "@acode/services";
import type {
  ACodePermissionResponse,
  ACodeSessionInfo,
  ACodeSessionMode,
  ACodeSessionStateSnapshot,
} from "@acode/shared";
import { isHarnessMethodName } from "@acode/shared/harness-api";
import {
  HarnessMethodError,
  notSupported,
  parseHarnessMethodParams,
  type Handler,
  type HarnessTranslateContext,
} from "./translateSupport.js";
import { RUN_DEFAULT_TIMEOUT_MS, runAndWaitTurn } from "./translateRun.js";

const SESSION_MODES: readonly string[] = ["plan", "build", "edit", "yolo", "auto"];

function requireAgent(services: ServiceCollection): IACodeAgentService {
  const agent = services.getOptional(IACodeAgentService);
  if (!agent) throw new HarnessMethodError("unavailable", "IACodeAgentService is not registered");
  return agent;
}

function requireTask(services: ServiceCollection): IACodeTaskService {
  const task = services.getOptional(IACodeTaskService);
  if (!task) throw new HarnessMethodError("unavailable", "IACodeTaskService is not registered");
  return task;
}

function sessionSummary(info: ACodeSessionInfo) {
  return {
    sessionId: info.sessionId,
    ...(info.parentSessionId ? { parentSessionId: info.parentSessionId } : {}),
    ...(info.title !== undefined ? { title: info.title } : {}),
    ...(info.mode !== undefined ? { mode: info.mode } : {}),
    ...(info.status !== undefined ? { status: info.status } : {}),
    ...(info.model ? { model: info.model } : {}),
    ...(info.createdAt !== undefined ? { createdAt: info.createdAt } : {}),
    ...(info.updatedAt !== undefined ? { updatedAt: info.updatedAt } : {}),
  };
}

function createSessionResultOf(snapshot: ACodeSessionStateSnapshot) {
  return {
    sessionId: snapshot.session.sessionId,
    ...(snapshot.session.status !== undefined ? { status: snapshot.session.status } : {}),
  };
}

function asSessionMode(value: string | undefined): ACodeSessionMode | undefined {
  if (value === undefined) return undefined;
  if (!SESSION_MODES.includes(value)) {
    throw new HarnessMethodError(
      "invalid_params",
      `unknown session mode '${value}' (expected one of ${SESSION_MODES.join("/")})`,
    );
  }
  return value as ACodeSessionMode;
}

function workspaceOf(params: { workspacePath: string; workspaceIdentity?: string }): {
  workspacePath: string;
  workspaceIdentity?: string;
} {
  const target: { workspacePath: string; workspaceIdentity?: string } = {
    workspacePath: params.workspacePath,
  };
  if (params.workspaceIdentity) target.workspaceIdentity = params.workspaceIdentity;
  return target;
}

function sessionTargetOf(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
}): { workspacePath: string; workspaceIdentity?: string; sessionId: string } {
  return { ...workspaceOf(params), sessionId: params.sessionId };
}

/** IACodeTaskService 面以 taskId 指代会话（taskId ≡ sessionId，见 adapter resolveInteraction envelope）。 */
function taskTargetOf(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
}): { taskId: string; workspacePath?: string; workspaceIdentity?: string } {
  const target: { taskId: string; workspacePath?: string; workspaceIdentity?: string } = {
    taskId: params.sessionId,
  };
  if (params.workspacePath) target.workspacePath = params.workspacePath;
  if (params.workspaceIdentity) target.workspaceIdentity = params.workspaceIdentity;
  return target;
}

/** 方法分发表：方法名 → 翻译到 services 层的处理器。 */
export function createHarnessMethodHandlers(
  context: HarnessTranslateContext,
): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  // H2：parseParams = 方法面 schema safeParse（未知字段剥离 + 严格类型校验）。
  const parseParams = parseHarnessMethodParams;

  handlers.set("list_sessions", async (raw) => {
    const params = parseParams("list_sessions", raw);
    const services = await context.getServices();
    const agent = requireAgent(services);
    const sessions = await agent.listSessions({
      ...workspaceOf(params),
      ...(params.includeArchived === true ? { includeArchived: true } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
    });
    return { sessions: sessions.map(sessionSummary) };
  });

  handlers.set("create_session", async (raw) => {
    const params = parseParams("create_session", raw);
    if (typeof params.systemPrompt === "string" && params.systemPrompt.length > 0) {
      throw notSupported(
        "create_session.systemPrompt",
        "services 层 createSession 无 systemPrompt 入参；v1 不透传给引擎（不静默忽略）",
      );
    }
    const services = await context.getServices();
    const agent = requireAgent(services);
    const snapshot = await agent.createSession({
      ...workspaceOf(params),
      ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
      ...(params.parentSessionId !== undefined
        ? { parentSessionId: params.parentSessionId }
        : {}),
      ...(asSessionMode(params.mode) ? { mode: asSessionMode(params.mode) } : {}),
      ...(params.model ? { model: params.model as never } : {}),
      ...(params.toolDenylist ? { toolDenylist: params.toolDenylist } : {}),
    });
    return createSessionResultOf(snapshot);
  });

  handlers.set("attach_session", async (raw) => {
    const params = parseParams("attach_session", raw);
    const services = await context.getServices();
    const agent = requireAgent(services);
    const snapshot = await agent.resumeSession(sessionTargetOf(params));
    return createSessionResultOf(snapshot);
  });

  handlers.set("detach_session", async (raw) => {
    const params = parseParams("detach_session", raw);
    const services = await context.getServices();
    // detach = 客户端不再持有该会话：释放为此连接拉起的空闲预热会话即可，
    // 绝不 closeSession（会终止会话本体——detach 语义是“放手”不是“关闭”）。
    const task = requireTask(services);
    await task.releaseWorkspacePreparation(workspaceOf(params));
    return { detached: true };
  });

  handlers.set("fork_session", async (raw) => {
    const params = parseParams("fork_session", raw);
    const services = await context.getServices();
    const agent = requireAgent(services);
    const snapshot = await agent.createSession({
      ...workspaceOf(params),
      // H2：schema 保证 sessionId 为非空 string，直接透传（此前 String(undefined)
      // 会把缺参变形为 parentSessionId:"undefined" 的会话——实证缺陷）。
      parentSessionId: params.sessionId,
    });
    return createSessionResultOf(snapshot);
  });

  handlers.set("rewind_session", (raw) => {
    parseParams("rewind_session", raw);
    // services 层只有 v4 文件 rewind preview 与 CLI 内建 /rewind 命令，
    // 没有会话级 rewind 入口；方法保留在面上、如实降级（spec 附录登记）。
    throw notSupported(
      "rewind_session",
      "services 层无会话级 rewind API（仅 CLI 内建 /rewind 与 v4 文件 rewind 预览）；等 additive 落地后解除",
    );
  });

  handlers.set("send_message", async (raw) => {
    const params = parseParams("send_message", raw);
    const services = await context.getServices();
    const agent = requireAgent(services);
    const result = await agent.sendPrompt({
      ...sessionTargetOf(params),
      // H2：schema 保证 content 为非空 string（此前 String(undefined) 发出 "undefined" 消息）。
      content: params.content,
      ...(params.model ? { modelSelection: params.model as never } : {}),
      ...(params.toolDenylist ? { toolDenylist: params.toolDenylist } : {}),
    });
    return {
      accepted: true as const,
      ...(typeof result.stateRevision === "number" ? { revision: result.stateRevision } : {}),
    };
  });

  handlers.set("cancel_turn", async (raw) => {
    const params = parseParams("cancel_turn", raw);
    const services = await context.getServices();
    const task = requireTask(services);
    await task.stopGeneration(taskTargetOf(params));
    return { cancelled: true };
  });

  handlers.set("run", async (raw) => {
    const params = parseParams("run", raw);
    const services = await context.getServices();
    const agent = requireAgent(services);
    const target = sessionTargetOf(params);
    const { terminal } = await runAndWaitTurn(
      agent,
      {
        workspacePath: target.workspacePath,
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
        sessionId: target.sessionId,
        // H2：schema 保证 content 为非空 string。
        content: params.content,
        // H1：run 预分配 inputId，引擎 turn 事件回显后作为终态归属依据。
        inputId: `harness-run-${randomUUID()}`,
        ...(params.model ? { model: params.model } : {}),
        ...(params.toolDenylist ? { toolDenylist: params.toolDenylist } : {}),
      },
      context.runTimeoutMs ?? RUN_DEFAULT_TIMEOUT_MS,
    );
    return {
      sessionId: target.sessionId,
      ...(terminal.inputId !== undefined ? { inputId: terminal.inputId } : {}),
      resultType: terminal.resultType,
      ...(terminal.response !== undefined ? { response: terminal.response } : {}),
      ...(terminal.usage !== undefined ? { usage: terminal.usage } : {}),
      ...(terminal.durationMs !== undefined ? { durationMs: terminal.durationMs } : {}),
      ...(terminal.error !== undefined ? { error: terminal.error } : {}),
    };
  });

  handlers.set("permission_respond", async (raw) => {
    const params = parseParams("permission_respond", raw);
    const services = await context.getServices();
    const task = requireTask(services);
    // services 层 respondPermission 的 response 字段在 v4 resolveInteraction 收敛路径上
    // 不被消费（决策完全由 optionId 承载，见 acodeTaskServiceAdapter.respondPermission），
    // 这里传中性 decision 仅满足入参 schema；harness 面不暴露伪造 decision 的字段。
    const neutralResponse: ACodePermissionResponse = { decision: "allow" };
    const accepted = await task.respondPermission({
      ...taskTargetOf(params),
      // H2：schema 保证 requestId/optionId 为非空 string（此前 String(undefined) 透传）。
      requestId: params.requestId,
      optionId: params.optionId,
      response: neutralResponse,
    });
    return { accepted };
  });

  handlers.set("set_model", async (raw) => {
    const params = parseParams("set_model", raw);
    const services = await context.getServices();
    const agent = requireAgent(services);
    await agent.setModel({
      ...sessionTargetOf(params),
      model: params.model as never,
    });
    return {};
  });

  handlers.set("get_models", async (raw) => {
    parseParams("get_models", raw);
    const services = await context.getServices();
    const selection = services.getOptional(IModelSelectionService);
    if (!selection)
      throw new HarnessMethodError("unavailable", "IModelSelectionService is not registered");
    const view = await selection.getView();
    return {
      providers: (view.providers ?? []).map((provider) => ({
        providerId: provider.providerId,
        ...(provider.providerName ? { providerName: provider.providerName } : {}),
        models: (provider.models ?? []).map((model) => ({ modelId: model.modelId })),
      })),
      ...(view.preferredSelection ? { preferredSelection: view.preferredSelection } : {}),
    };
  });

  handlers.set("compact", async (raw) => {
    const params = parseParams("compact", raw);
    const services = await context.getServices();
    const agent = requireAgent(services);
    await agent.compactSession({
      ...sessionTargetOf(params),
      ...(params.instructions !== undefined ? { instructions: params.instructions } : {}),
    });
    return {};
  });

  handlers.set("read_file", async (raw) => {
    const params = parseParams("read_file", raw);
    const services = await context.getServices();
    const file = services.getOptional(IFileService);
    if (!file) throw new HarnessMethodError("unavailable", "IFileService is not registered");
    const slice = await file.readTextFile({
      // H2：schema 保证 path 为非空 string（此前 String(undefined) 透传）。
      path: params.path,
      ...(params.offset !== undefined ? { offset: params.offset } : {}),
      ...(params.length !== undefined ? { length: params.length } : {}),
    });
    return {
      path: slice.path,
      content: slice.content,
      offset: slice.offset,
      bytesRead: slice.bytesRead,
      totalBytes: slice.totalBytes,
      truncated: slice.truncated,
      isBinary: slice.isBinary,
    };
  });

  handlers.set("search_text", (raw) => {
    parseParams("search_text", raw);
    // IFileService 只有文件名模糊搜索（searchWorkspaceFiles），无内容 grep；
    // 内容检索能力在 agent 工具面（rg）而非 services 层。如实降级。
    throw notSupported(
      "search_text",
      "services 层无内容检索 API（IFileService 仅文件名搜索）；嵌入方可经 send_message 使用引擎检索工具",
    );
  });

  handlers.set("find_files", async (raw) => {
    const params = parseParams("find_files", raw);
    const services = await context.getServices();
    const file = services.getOptional(IFileService);
    if (!file) throw new HarnessMethodError("unavailable", "IFileService is not registered");
    const entries = await file.searchWorkspaceFiles({
      // H2：schema 保证 rootPath/query 为非空 string、limit 为正整数 ≤500
      // （此前 limit 1e9 等越界值经 typeof 检查直通——实证缺陷）。
      rootPath: params.rootPath,
      query: params.query,
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
    });
    return {
      entries: entries.map((entry) => ({
        name: entry.name,
        path: entry.path,
        ...(entry.relativePath ? { relativePath: entry.relativePath } : {}),
        type: entry.type,
      })),
    };
  });

  handlers.set("configure_tools", (raw) => {
    parseParams("configure_tools", raw);
    // 工具控制在 services 层是 create/resume/send 时点的 toolAllowlist/toolDenylist 参数，
    // 无 create 后的会话级动态配置面，也无自定义工具注册回调；如实降级。
    // 可用替代：create_session.toolDenylist（创建时禁用清单）。
    throw notSupported(
      "configure_tools",
      "services 层无 create 后的会话级工具配置面；禁用清单请在 create_session.toolDenylist 传入",
      "create_session.toolDenylist",
    );
  });

  return handlers;
}

/** 供 server.ts 校验方法名（未注册的方法名统一 unknown_method）。 */
export function assertKnownHarnessMethod(method: string): void {
  if (!isHarnessMethodName(method)) {
    throw new HarnessMethodError("unknown_method", `unknown harness method '${method}'`);
  }
}
