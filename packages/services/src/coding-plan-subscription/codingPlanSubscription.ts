import type {
  CodingPlanAgreementResponse,
  CodingPlanBatchPreviewRequest,
  CodingPlanBatchPreviewResponse,
  CodingPlanCreateSignRequest,
  CodingPlanPaymentCheckRequest,
  CodingPlanPaymentCheckResponse,
  CodingPlanPendingOrderCheckRequest,
  CodingPlanPendingOrderCheckResponse,
  CodingPlanPaypalSetupTokenRequest,
  CodingPlanPaypalSetupTokenResponse,
  CodingPlanPaypalSubscribeRequest,
  CodingPlanPaypalSubscribeResponse,
  CodingPlanPaypalSupportRequest,
  CodingPlanPaypalSupportResponse,
  CodingPlanProductInfo,
  CodingPlanProductInfoRequest,
  CodingPlanStaticProductsConfig,
  CodingPlanStaticTeamProductsConfig,
  CodingPlanPreviewRequest,
  CodingPlanPreviewResponse,
  CodingPlanStripeBindRequest,
  CodingPlanStripeBindResponse,
  CodingPlanStripeCard,
  CodingPlanStripePayRequest,
  CodingPlanStripePayResponse,
  CodingPlanStripeUnbindRequest,
  CodingPlanUpdateSignRequest,
  EnterpriseCodingPlanCreateOrderRequest,
  EnterpriseCodingPlanCreateOrderResponse,
  EnterpriseCodingPlanCancelOrderRequest,
  EnterpriseCodingPlanCancelOrderResponse,
  EnterpriseCodingPlanBalanceResponse,
  EnterpriseCodingPlanContinuePayRequest,
  EnterpriseCodingPlanOrderCalculateRequest,
  EnterpriseCodingPlanOrderCalculateResponse,
  EnterpriseCodingPlanPendingOrder,
  EnterpriseCodingPlanOrderStatusRequest,
  EnterpriseCodingPlanOrderStatusResponse,
  EnterpriseCodingPlanPricingRequest,
  EnterpriseCodingPlanPricingResponse,
  StartPlanPreviewConfig,
  ACodeModelContextBudgetStrategy,
  ForceUpdateConfig,
  DynamicWorkflowClientConfig,
} from "@acode/shared";
import type { ModelSelectionView } from "@acode/provider";
import { ServiceChannels } from "@acode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface OffPeakClientConfig {
  readonly enabled: boolean;
  readonly modelSelectionView: ModelSelectionView;
  /** mock 演示强制通道：真实路径不下发，UI 使用 Host 的 Account support。 */
  readonly codingPlanActive?: boolean;
}

export interface ICodingPlanSubscriptionService {
  batchPreview(request?: CodingPlanBatchPreviewRequest): Promise<CodingPlanBatchPreviewResponse>;
  getStaticProducts(): Promise<CodingPlanStaticProductsConfig>;
  getStaticTeamProducts(): Promise<CodingPlanStaticTeamProductsConfig>;
  getStartPlanPreview(): Promise<StartPlanPreviewConfig | null>;
  /** 闲时任务灰度配置：forceRefresh 供入口打开时补拉（绕过 1h 快照缓存）。 */
  getOffPeakClientConfig(options?: { forceRefresh?: boolean }): Promise<OffPeakClientConfig>;
  /**
   * 动态工作流灰度快照：远端 `configs.dynamicWorkflow.mode`
   * 与本地覆盖折叠后的结果；forceRefresh 绕过 1h 快照缓存。请求失败 fail-closed（disabled/default）。
   */
  getDynamicWorkflowClientConfig(options?: {
    forceRefresh?: boolean;
  }): Promise<DynamicWorkflowClientConfig>;
  /** 兼容接口：固定返回 preflight-v1，不读取远端配置或缓存。 */
  getModelContextBudgetStrategy(): Promise<ACodeModelContextBudgetStrategy>;
  getForceUpdateConfig(): Promise<ForceUpdateConfig | null>;
  productInfo(request: CodingPlanProductInfoRequest): Promise<CodingPlanProductInfo>;
  preview(request: CodingPlanPreviewRequest): Promise<CodingPlanPreviewResponse>;
  createSign(request: CodingPlanCreateSignRequest): Promise<CodingPlanAgreementResponse>;
  updateSign(request: CodingPlanUpdateSignRequest): Promise<CodingPlanAgreementResponse>;
  checkPayment(request: CodingPlanPaymentCheckRequest): Promise<CodingPlanPaymentCheckResponse>;
  checkPendingOrders(
    request?: CodingPlanPendingOrderCheckRequest,
  ): Promise<CodingPlanPendingOrderCheckResponse>;
  queryStripeCards(request?: {
    providerId?: CodingPlanPreviewRequest["providerId"];
  }): Promise<CodingPlanStripeCard[]>;
  bindStripeCard(request: CodingPlanStripeBindRequest): Promise<CodingPlanStripeBindResponse>;
  unbindStripeCard(request: CodingPlanStripeUnbindRequest): Promise<string>;
  payStripe(request: CodingPlanStripePayRequest): Promise<CodingPlanStripePayResponse>;
  checkPaypalSupport(
    request?: CodingPlanPaypalSupportRequest,
  ): Promise<CodingPlanPaypalSupportResponse>;
  createPaypalSetupToken(
    request: CodingPlanPaypalSetupTokenRequest,
  ): Promise<CodingPlanPaypalSetupTokenResponse>;
  subscribePaypal(
    request: CodingPlanPaypalSubscribeRequest,
  ): Promise<CodingPlanPaypalSubscribeResponse>;
  getEnterprisePricing(
    request?: EnterpriseCodingPlanPricingRequest,
  ): Promise<EnterpriseCodingPlanPricingResponse>;
  getEnterpriseBalance(): Promise<EnterpriseCodingPlanBalanceResponse>;
  calculateEnterpriseOrder(
    request: EnterpriseCodingPlanOrderCalculateRequest,
  ): Promise<EnterpriseCodingPlanOrderCalculateResponse>;
  createEnterpriseOrder(
    request: EnterpriseCodingPlanCreateOrderRequest,
  ): Promise<EnterpriseCodingPlanCreateOrderResponse>;
  getEnterprisePendingOrders(): Promise<EnterpriseCodingPlanPendingOrder[]>;
  cancelEnterpriseOrder(
    request: EnterpriseCodingPlanCancelOrderRequest,
  ): Promise<EnterpriseCodingPlanCancelOrderResponse>;
  continueEnterpriseOrderPayment(
    request: EnterpriseCodingPlanContinuePayRequest,
  ): Promise<EnterpriseCodingPlanCreateOrderResponse>;
  checkEnterpriseOrderStatus(
    request: EnterpriseCodingPlanOrderStatusRequest,
  ): Promise<EnterpriseCodingPlanOrderStatusResponse>;
}

export const ICodingPlanSubscriptionService =
  createServiceDescriptor<ICodingPlanSubscriptionService>(ServiceChannels.CodingPlanSubscription, {
    allowedMethods: [
      "batchPreview",
      "getStaticProducts",
      "getStaticTeamProducts",
      "getStartPlanPreview",
      "getOffPeakClientConfig",
      "getDynamicWorkflowClientConfig",
      "getModelContextBudgetStrategy",
      "getForceUpdateConfig",
      "productInfo",
      "preview",
      "createSign",
      "updateSign",
      "checkPayment",
      "checkPendingOrders",
      "queryStripeCards",
      "bindStripeCard",
      "unbindStripeCard",
      "payStripe",
      "checkPaypalSupport",
      "createPaypalSetupToken",
      "subscribePaypal",
      "getEnterprisePricing",
      "getEnterpriseBalance",
      "calculateEnterpriseOrder",
      "createEnterpriseOrder",
      "getEnterprisePendingOrders",
      "cancelEnterpriseOrder",
      "continueEnterpriseOrderPayment",
      "checkEnterpriseOrderStatus",
    ],
    argumentValidators: {
      // 读取类无参入口：拒绝任何多余实参。
      getStaticProducts: (args) => requireNoArguments(args),
      getStaticTeamProducts: (args) => requireNoArguments(args),
      getStartPlanPreview: (args) => requireNoArguments(args),
      getModelContextBudgetStrategy: (args) => requireNoArguments(args),
      getForceUpdateConfig: (args) => requireNoArguments(args),
      getEnterpriseBalance: (args) => requireNoArguments(args),
      getEnterprisePendingOrders: (args) => requireNoArguments(args),
      // 可选 request 对象：接受缺省/undefined/null；存在时必须是非数组对象。
      batchPreview: (args) => optionalSingleObjectArg(args),
      getOffPeakClientConfig: (args) => optionalSingleObjectArg(args),
      getDynamicWorkflowClientConfig: (args) => optionalSingleObjectArg(args),
      checkPendingOrders: (args) => optionalSingleObjectArg(args),
      queryStripeCards: (args) => optionalSingleObjectArg(args),
      checkPaypalSupport: (args) => optionalSingleObjectArg(args),
      getEnterprisePricing: (args) => optionalSingleObjectArg(args),
      // 必填 request 对象：只校验明确的必需 id 字段（productId/bizId/orderNo/支付回调 URL），
      // 金额、订阅周期等业务字段的完整校验留在 service 层，保持宽容避免误拒。
      productInfo: (args) => requireObjectArg(args, ["productId"]),
      preview: (args) => requireObjectArg(args, ["productId"]),
      createSign: (args) => requireObjectArg(args, ["bizId"]),
      updateSign: (args) => requireObjectArg(args, ["bizId"]),
      checkPayment: (args) => requireObjectArg(args, ["bizId"]),
      bindStripeCard: (args) => requireObjectArg(args, ["paymentMethodId"]),
      unbindStripeCard: (args) => requireObjectArg(args, ["paymentMethodId"]),
      payStripe: (args) => requireObjectArg(args, ["productId"]),
      createPaypalSetupToken: (args) => requireObjectArg(args, ["returnUrl", "cancelUrl"]),
      subscribePaypal: (args) => requireObjectArg(args, ["productId"]),
      calculateEnterpriseOrder: (args) => requireObjectArg(args, ["productId"]),
      createEnterpriseOrder: (args) => requireObjectArg(args, ["productId"]),
      cancelEnterpriseOrder: (args) => requireObjectArg(args, ["orderNo"]),
      continueEnterpriseOrderPayment: (args) => requireObjectArg(args, ["orderNo"]),
      checkEnterpriseOrderStatus: (args) => requireObjectArg(args, ["orderNo"]),
    },
  });

function requireNoArguments(args: readonly unknown[]): void {
  if (args.length !== 0) throw new Error("expected no arguments");
}

function optionalSingleObjectArg(args: readonly unknown[]): void {
  if (args.length > 1) throw new Error("expected at most one argument");
  const value = args[0];
  if (args.length === 0 || value === undefined || value === null) return;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected an optional parameter object");
  }
}

function requireObjectArg(
  args: readonly unknown[],
  requiredStringFields: readonly string[],
): Record<string, unknown> {
  if (args.length !== 1) throw new Error("expected a single request object");
  const value = args[0];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected a request object");
  }
  const record = value as Record<string, unknown>;
  for (const field of requiredStringFields) {
    const fieldValue = record[field];
    if (typeof fieldValue !== "string" || fieldValue.length === 0) {
      throw new Error(`invalid ${field}`);
    }
  }
  return record;
}
