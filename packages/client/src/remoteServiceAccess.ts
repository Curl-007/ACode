import { ProxyChannel, type IChannelClient, type IDisposable } from "@acode/rpc";
import {
  IFileService,
  IMediaPreviewService,
  IGitService,
  IGitCheckpointService,
  ISystemService,
  ITerminalService,
  ISettingService,
  IOnboardingRecordService,
  ICredentialService,
  IBroadcastService,
  IACodeTaskService,
  IACodeAgentService,
  IACodeSessionService,
  ICuaPermissionService,
  IBotsService,
  IFileWatcherService,
  IOAuthService,
  IModelSelectionService,
  IProviderSettingsService,
  IProviderProvisioningTargetService,
  IUsageStatsService,
  ICodingPlanSubscriptionService,
  IClientConfigService,
  IClientScenesService,
  IOffPeakTaskService,
  ISkillsService,
  ISkillSyncService,
  IMcpSyncService,
  IPluginSyncService,
  IPluginsService,
  IPluginManagementService,
  ISubagentsService,
  ICommandsService,
  IHooksService,
  IMemoryService,
  ISettingsSyncService,
  IFeedbackService,
  IPromptAttachmentTransferService,
  IWindowControllerService,
  type IServiceAccessor,
} from "@acode/services";

/**
 * 带幂等释放边界的 `IServiceAccessor`——WebSocket / 裸协议连接的门面类型。
 *
 * 除服务代理外额外暴露 `dispose()`：关闭底层传输（WebSocket/port）+ dispose ChannelClient
 *（reject 挂起 RPC，fail-closed），幂等（重复调用只生效一次）。消费方（如 web 重连换代丢弃
 * 孤儿连接时）据此释放已打开的活 socket，而非静默丢弃——与 `MessagePortServiceConnection.dispose`
 * 同一「一次性释放边界」语义（specs/module-boundary.md）。
 */
export interface DisposableServiceAccessor extends IServiceAccessor {
  /** 幂等释放底层连接（WebSocket/port + ChannelClient）；重复调用只生效一次。 */
  dispose(): void;
}

/**
 * RemoteServiceAccess — 通过 ChannelClient 自动创建类型安全的服务代理
 *
 * 新增服务只需在此添加一个 getter。
 */
export class RemoteServiceAccess implements DisposableServiceAccessor {
  readonly fileService: IFileService;
  readonly mediaPreviewService: IMediaPreviewService;
  readonly gitService: IGitService;
  readonly gitCheckpointService: IGitCheckpointService;
  readonly systemService: ISystemService;
  readonly terminalService: ITerminalService;
  readonly settingService: ISettingService;
  readonly onboardingRecordService: IOnboardingRecordService;
  readonly credentialService: ICredentialService;
  readonly broadcastService: IBroadcastService;
  readonly acodeTaskService: IACodeTaskService;
  readonly windowControllerService: IWindowControllerService;
  readonly acodeAgentService: IACodeAgentService;
  readonly acodeSessionService: IACodeSessionService;
  // cuaPermissionService 在 IServiceAccessor 上是可选（远端/bots host 不提供），但桌面 renderer
  // 经 RPC 一定能拿到（main host 始终注册此 descriptor；非 macOS / 未启用时方法返回 available:false）。
  readonly cuaPermissionService: ICuaPermissionService;
  readonly botsService: IBotsService;
  readonly fileWatcherService: IFileWatcherService;
  readonly oauthService: IOAuthService;
  readonly providerSettingsService: IProviderSettingsService;
  readonly modelSelectionService: IModelSelectionService;
  /** Host-only target proxy；不属于 IServiceAccessor，避免向 Renderer 暴露 Secret 写入接口。 */
  readonly providerProvisioningTargetService!: IProviderProvisioningTargetService;
  readonly usageStatsService: IUsageStatsService;
  readonly codingPlanSubscriptionService: ICodingPlanSubscriptionService;
  readonly clientConfigService: IClientConfigService;
  readonly clientScenesService: IClientScenesService;
  readonly offPeakTaskService: IOffPeakTaskService;
  readonly skillsService: ISkillsService;
  readonly skillSyncService: ISkillSyncService;
  readonly mcpSyncService: IMcpSyncService;
  readonly pluginSyncService: IPluginSyncService;
  readonly pluginsService: IPluginsService;
  readonly pluginManagementService: IPluginManagementService;
  readonly subagentsService: ISubagentsService;
  readonly commandsService: ICommandsService;
  readonly hooksService: IHooksService;
  readonly memoryService: IMemoryService;
  readonly settingsSyncService: ISettingsSyncService;
  readonly feedbackService: IFeedbackService;
  readonly promptAttachmentTransferService: IPromptAttachmentTransferService;

  /** 底层传输的一次性释放边界（client+protocol+socket 的收口），由连接工厂注入；缺省时 dispose 为 no-op。 */
  private readonly transport?: IDisposable;
  private disposed = false;

  constructor(channelClient: IChannelClient, transport?: IDisposable) {
    this.transport = transport;
    this.fileService = ProxyChannel.toService<IFileService>(
      channelClient.getChannel(IFileService.channelName),
    );
    // Host 已注册 media-preview channel，但遗漏 renderer proxy 时，PreviewPane
    // 会静默回退到 8 MiB 的 file.readMediaPreview，导致大 MP4 无法打开。
    this.mediaPreviewService = ProxyChannel.toService<IMediaPreviewService>(
      channelClient.getChannel(IMediaPreviewService.channelName),
    );
    this.gitService = ProxyChannel.toService<IGitService>(
      channelClient.getChannel(IGitService.channelName),
    );
    this.gitCheckpointService = ProxyChannel.toService<IGitCheckpointService>(
      channelClient.getChannel(IGitCheckpointService.channelName),
    );
    this.systemService = ProxyChannel.toService<ISystemService>(
      channelClient.getChannel(ISystemService.channelName),
    );
    this.terminalService = ProxyChannel.toService<ITerminalService>(
      channelClient.getChannel(ITerminalService.channelName),
    );
    this.settingService = ProxyChannel.toService<ISettingService>(
      channelClient.getChannel(ISettingService.channelName),
    );
    this.onboardingRecordService = ProxyChannel.toService<IOnboardingRecordService>(
      channelClient.getChannel(IOnboardingRecordService.channelName),
    );
    this.credentialService = ProxyChannel.toService<ICredentialService>(
      channelClient.getChannel(ICredentialService.channelName),
    );
    this.broadcastService = ProxyChannel.toService<IBroadcastService>(
      channelClient.getChannel(IBroadcastService.channelName),
    );
    this.acodeTaskService = ProxyChannel.toService<IACodeTaskService>(
      channelClient.getChannel(IACodeTaskService.channelName),
    );
    this.windowControllerService = ProxyChannel.toService<IWindowControllerService>(
      channelClient.getChannel(IWindowControllerService.channelName),
    );
    this.acodeAgentService = ProxyChannel.toService<IACodeAgentService>(
      channelClient.getChannel(IACodeAgentService.channelName),
    );
    this.acodeSessionService = ProxyChannel.toService<IACodeSessionService>(
      channelClient.getChannel(IACodeSessionService.channelName),
    );
    this.cuaPermissionService = ProxyChannel.toService<ICuaPermissionService>(
      channelClient.getChannel(ICuaPermissionService.channelName),
    );
    this.botsService = ProxyChannel.toService<IBotsService>(
      channelClient.getChannel(IBotsService.channelName),
    );
    this.fileWatcherService = ProxyChannel.toService<IFileWatcherService>(
      channelClient.getChannel(IFileWatcherService.channelName),
    );
    this.oauthService = ProxyChannel.toService<IOAuthService>(
      channelClient.getChannel(IOAuthService.channelName),
    );
    this.providerSettingsService = ProxyChannel.toService<IProviderSettingsService>(
      channelClient.getChannel(IProviderSettingsService.channelName),
    );
    this.modelSelectionService = ProxyChannel.toService<IModelSelectionService>(
      channelClient.getChannel(IModelSelectionService.channelName),
    );
    Object.defineProperty(this, "providerProvisioningTargetService", {
      value: ProxyChannel.toService<IProviderProvisioningTargetService>(
        channelClient.getChannel(IProviderProvisioningTargetService.channelName),
      ),
      enumerable: false,
    });
    this.usageStatsService = ProxyChannel.toService<IUsageStatsService>(
      channelClient.getChannel(IUsageStatsService.channelName),
    );
    this.codingPlanSubscriptionService = ProxyChannel.toService<ICodingPlanSubscriptionService>(
      channelClient.getChannel(ICodingPlanSubscriptionService.channelName),
    );
    this.clientConfigService = ProxyChannel.toService<IClientConfigService>(
      channelClient.getChannel(IClientConfigService.channelName),
    );
    this.clientScenesService = ProxyChannel.toService<IClientScenesService>(
      channelClient.getChannel(IClientScenesService.channelName),
    );
    this.offPeakTaskService = ProxyChannel.toService<IOffPeakTaskService>(
      channelClient.getChannel(IOffPeakTaskService.channelName),
    );
    this.skillsService = ProxyChannel.toService<ISkillsService>(
      channelClient.getChannel(ISkillsService.channelName),
    );
    this.skillSyncService = ProxyChannel.toService<ISkillSyncService>(
      channelClient.getChannel(ISkillSyncService.channelName),
    );
    this.mcpSyncService = ProxyChannel.toService<IMcpSyncService>(
      channelClient.getChannel(IMcpSyncService.channelName),
    );
    this.pluginSyncService = ProxyChannel.toService<IPluginSyncService>(
      channelClient.getChannel(IPluginSyncService.channelName),
    );
    this.pluginsService = ProxyChannel.toService<IPluginsService>(
      channelClient.getChannel(IPluginsService.channelName),
    );
    this.pluginManagementService = ProxyChannel.toService<IPluginManagementService>(
      channelClient.getChannel(IPluginManagementService.channelName),
    );
    this.subagentsService = ProxyChannel.toService<ISubagentsService>(
      channelClient.getChannel(ISubagentsService.channelName),
    );
    this.commandsService = ProxyChannel.toService<ICommandsService>(
      channelClient.getChannel(ICommandsService.channelName),
    );
    this.hooksService = ProxyChannel.toService<IHooksService>(
      channelClient.getChannel(IHooksService.channelName),
    );
    this.memoryService = ProxyChannel.toService<IMemoryService>(
      channelClient.getChannel(IMemoryService.channelName),
    );
    this.settingsSyncService = ProxyChannel.toService<ISettingsSyncService>(
      channelClient.getChannel(ISettingsSyncService.channelName),
    );
    this.feedbackService = ProxyChannel.toService<IFeedbackService>(
      channelClient.getChannel(IFeedbackService.channelName),
    );
    this.promptAttachmentTransferService = ProxyChannel.toService<IPromptAttachmentTransferService>(
      channelClient.getChannel(IPromptAttachmentTransferService.channelName),
    );
  }

  /**
   * 幂等释放底层连接（transport 由连接工厂注入，收口 client+protocol+socket）。
   *
   * 修复依据（specs/module-boundary.md）：web 重连换代时会丢弃在途 connect 的 resolve 结果，
   * 此前门面无任何释放路径，打开的 WebSocket + ChannelClient 泄漏。dispose() 提供对称的
   * 一次性释放边界，与 MessagePortServiceConnection.dispose 同语义。重复调用只生效一次
   *（disposed 守卫），未注入 transport 时为 no-op（例如仅用 ChannelClient 构造的裸门面）。
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.transport?.dispose();
  }
}
