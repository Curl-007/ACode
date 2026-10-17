import { app, session, type Session } from "electron";
import { shouldBlockOfficialPlatformUrl } from "@acode/shared";

/** egress 诊断观察者所需的最小日志面（desktopNetworkPolicy.ts 同款结构端口）。 */
interface OfficialPlatformPolicyLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/**
 * 未登记出站面诊断观察者的工厂形状（specs/update-gates-endpoint-registry.md）。
 * 由接线方（index.ts）注入 desktopNetworkPolicy.createEgressDiagnosticsObserver——
 * 本模块保持依赖叶子（不 import desktopNetworkPolicy），既有测试替身面不扩大。
 */
export type OfficialPlatformEgressObserverFactory = (
  logger: OfficialPlatformPolicyLogger,
  origin: "main" | "renderer" | "subprocess",
) => (details: { url: string }) => void;

/**
 * 审计版不连接官方平台：覆盖历史缓存图片、webview、重定向和 Electron net 请求。
 *
 * 本模块是全仓唯一的 onBeforeRequest 所有者（Electron 每 session 每事件只允许一个
 * 监听器）；W1-11 的未登记出站面 warn-only 诊断观察者只能组合进这里的既有监听器，
 * 绝不允许在别处另行注册顶掉官方平台阻断。观察者只组合 defaultSession（应用自身
 * main+renderer 流量）；session-created 到达的 embedded-browser 等用户自有浏览面
 * partition 不组合、不诊断（spec 接线需求）。诊断是旁路观察者：工厂产物内部已
 * try/catch，异常不影响请求主路径与阻断裁决。
 */
export function installOfficialPlatformNetworkPolicy(options?: {
  logger?: OfficialPlatformPolicyLogger;
  createEgressObserver?: OfficialPlatformEgressObserverFactory;
}): void {
  const observeEgress =
    options?.logger && options.createEgressObserver
      ? options.createEgressObserver(options.logger, "renderer")
      : null;
  const install = (target: Session, withEgressDiagnostics: boolean) => {
    const observer = withEgressDiagnostics ? observeEgress : null;
    target.webRequest.onBeforeRequest((details, callback) => {
      observer?.(details);
      callback({ cancel: shouldBlockOfficialPlatformUrl(details.url) });
    });
  };
  app.on("session-created", (createdSession) => install(createdSession, false));
  // 注册必须先于 app ready；defaultSession 也可能已由其它初始化代码创建。
  void app.whenReady().then(() => install(session.defaultSession, true));
}
