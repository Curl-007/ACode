import { net } from "electron";
import {
  buildHelpAppConfigUrl,
  buildACodeSourceHeadersFromContext,
  createHelpAppConfigReader,
  ACODE_ENV,
} from "@acode/shared";

export function createDesktopHelpConfigReader(options: {
  resolveEndpointOrigin: () => Promise<string>;
  appVersion: string;
  deviceMid: string;
}) {
  const read = createHelpAppConfigReader({
    // fetchImpl 的全局 fetch 签名接受 string | URL | Request，Electron net.fetch 的类型
    // 签名不含 URL。reader 实际只传 string URL；对 URL 显式取 href（与 fetch 规范的
    // 字符串化结果一致），string/Request 原样透传，运行时行为不变。
    fetchImpl: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
  });
  return async () => {
    const endpointOrigin = await options.resolveEndpointOrigin();
    return read(
      buildHelpAppConfigUrl(
        endpointOrigin,
        options.appVersion,
        `${process.platform}-${process.arch}`,
      ),
      buildACodeSourceHeadersFromContext({
        endpointOrigin,
        appVersion: options.appVersion,
        deviceMid: options.deviceMid,
        platform: process.platform,
        arch: process.arch,
        releaseChannel: ACODE_ENV,
        sourceTitle: "electron",
      }),
    );
  };
}
