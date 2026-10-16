// manifest 验签接口预留 + 部署前 manifest 门禁（签名状态 + 版本兼容窗）。
// 规格见 packages/server/specs/remote-deploy-hardening.md R3。
//
// 钉扎公钥的密钥管理属发布管线，本批不实装密码学验签：只定义 verifier 接口
// 与 not-configured 缺省实现，并把它与兼容窗检查组合成 memoized guard，
// 让 deploy 的三条 manifest 获取路径共用同一裁决（一次 manifest 只检查一次）。
import type { DeployLoggers } from "@acode/server/remote/deployShared.js";
import {
  assessRemoteServerCompat,
  parseRemoteAssetManifestCompatWindow,
  RemoteServerCompatError,
} from "@acode/server/remote/remoteVersionCompat.js";

/** 验签结果状态闭集。not-configured = 尚无钉扎公钥/验签实现（登记项）。 */
export type RemoteAssetManifestSignatureStatus = "verified" | "invalid" | "not-configured";

export interface RemoteAssetManifestSignatureResult {
  readonly status: RemoteAssetManifestSignatureStatus;
  readonly detail?: string;
}

export interface RemoteAssetManifestSignatureVerifier {
  /**
   * 验证 manifest 的钉扎公钥签名。context.source 区分 CDN 直下与本地缓存
   * 物化路径；未来实现可据此消费签名 sidecar。接口约定：
   * - verified：签名有效；
   * - invalid：签名缺失/不匹配（部署必须拒绝）；
   * - not-configured：验签不可用（记录后放行，实装批次改为 fail-closed）。
   */
  verify(
    manifest: unknown,
    context: { source: "cdn" | "local-cache" },
  ): Promise<RemoteAssetManifestSignatureResult>;
}

export class RemoteAssetManifestSignatureError extends Error {
  readonly code = "remote-asset-manifest-signature-invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "RemoteAssetManifestSignatureError";
  }
}

export function createUnconfiguredManifestSignatureVerifier(): RemoteAssetManifestSignatureVerifier {
  return {
    async verify() {
      return { status: "not-configured" };
    },
  };
}

export interface RemoteAssetManifestGuard {
  /**
   * 检查一份 manifest（签名状态 + 兼容窗）；invalid / 窗外 → 抛错拒绝部署。
   * 结果按 manifest 对象 memoize：同一事务内多条获取路径共用同一裁决，
   * 失败裁决对同一对象保持稳定（重试用新 manifest 对象重新裁决）。
   */
  inspect(manifest: unknown, context: { source: "cdn" | "local-cache" }): Promise<void>;
}

export function createRemoteAssetManifestGuard(params: {
  currentVersion: string;
  signatureVerifier?: RemoteAssetManifestSignatureVerifier;
  loggers: DeployLoggers;
}): RemoteAssetManifestGuard {
  const { log, logWarn } = params.loggers;
  const verifier =
    params.signatureVerifier ?? createUnconfiguredManifestSignatureVerifier();
  const verdicts = new WeakMap<object, Promise<void>>();
  let notConfiguredLogged = false;

  const inspectOnce = async (
    manifest: object,
    context: { source: "cdn" | "local-cache" },
  ): Promise<void> => {
    let signatureResult: RemoteAssetManifestSignatureResult;
    try {
      signatureResult = await verifier.verify(manifest, context);
    } catch (error) {
      // 注入了 verifier 却抛错：验签器故障按 invalid fail-closed 处理，
      // 安全门禁不能因实现故障静默降级为放行。
      throw new RemoteAssetManifestSignatureError(
        `远端资产 manifest 验签器执行失败（来源 ${context.source}）：${String(error)}`,
      );
    }
    if (signatureResult.status === "invalid") {
      throw new RemoteAssetManifestSignatureError(
        `远端资产 manifest 签名无效（来源 ${context.source}）：` +
          `${signatureResult.detail ?? "签名缺失或与钉扎公钥不匹配"}；拒绝部署。`,
      );
    }
    if (signatureResult.status === "not-configured" && !notConfiguredLogged) {
      notConfiguredLogged = true;
      log(
        "[deploy-manifest] signature verification not configured; proceeding without verification (登记项：发布管线钉扎公钥)",
      );
    }

    const verdict = assessRemoteServerCompat({
      currentVersion: params.currentVersion,
      compatWindow: parseRemoteAssetManifestCompatWindow(manifest),
    });
    if (verdict.status === "out_of_window") {
      throw new RemoteServerCompatError(verdict.message);
    }
    if (verdict.status === "untested_warning") {
      logWarn(`[deploy-manifest] ${verdict.message}`);
      return;
    }
    if (verdict.status === "undeclared") {
      log("[deploy-manifest] compat window not declared; proceeding");
    }
  };

  return {
    inspect(manifest, context) {
      if (typeof manifest !== "object" || manifest === null) {
        // 非对象 manifest 属既有解析路径的失败形态，由 manifest 解析层报错。
        return Promise.resolve();
      }
      const existing = verdicts.get(manifest);
      if (existing) {
        return existing;
      }
      const verdict = inspectOnce(manifest, context);
      verdicts.set(manifest, verdict);
      // memoize 后若无人再消费该 rejected promise，避免 unhandled rejection；
      // 首个调用方仍拿到原始 rejection。
      verdict.catch(() => undefined);
      return verdict;
    },
  };
}
