// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/providers/base.ts
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// 适配：omp 的 authStorage/model/modelRegistry 字段不移植——ACode 凭据只走 env
// （credentials.ts），引擎按需自行读取；结构化查询与 recency 纪律注释照抄。

import type { StructuredQuery } from "../query-parse.js";
import type { SearchProviderId, SearchResponse } from "../types.js";

/** 各引擎共享的 web 搜索参数。 */
export interface SearchParams {
  query: string;
  /**
   * `query` 的结构化视图，搜索管线只解析一次：Google 风格指令（site:、
   * before:/after:、inurl:、intitle:、filetype:、引号短语、OR 组、-排除）拆进字段。
   *
   * 引擎 SHOULD 把约束映射到原生 API 参数（域/日期过滤）或引擎查询语法
   * （formatQuery），否则保持宽松：管线会用 applyQueryConstraints 对每个响应做
   * 后置过滤，会清空全部结果的约束会被放宽——尽力搜索好过空结果。缺省时用
   * parseSearchQuery(params.query) 解析。
   */
  parsedQuery?: StructuredQuery;
  limit?: number;
  /**
   * 把结果收窄到指定时间窗的纯时间过滤。
   *
   * 引擎 MUST 把它解释为纯时间过滤；MUST NOT 借 recency 隐式改写话题范围、内容域
   * 或排序策略。若引擎 API 把时间过滤与其他维度耦合（如 Tavily 的 topic=news），
   * 引擎实现负责在调用上游 API 前解耦。
   *
   * 不支持时间过滤的引擎 MUST 静默忽略本字段；MUST NOT 通过改写查询或其他请求
   * 参数去近似它。
   */
  recency?: "day" | "week" | "month" | "year";
  signal?: AbortSignal;
  /** 本引擎搜索传输的硬超时（毫秒）。 */
  timeoutMs?: number;
  fetch?: typeof fetch;
  numSearchResults?: number;
}

/** web 搜索引擎基类。 */
export abstract class SearchProvider {
  abstract readonly id: SearchProviderId;
  abstract readonly label: string;

  /**
   * 引擎此刻是否具备服务请求所需的凭据/配置（ACode 侧即 env 通道）。
   * 驱动回退链准入：返回 false 的引擎被静默跳过。显式点名走 isExplicitlyAvailable。
   */
  abstract isAvailable(): Promise<boolean> | boolean;

  /**
   * 用户在 ACODE_WEBSEARCH_ENGINES 显式点名时是否应执行，即使 isAvailable 会为
   * 自动链拒绝它。保留 omp 语义：无凭据回退被挡在自动链外的引擎覆写此方法，
   * 使显式点名仍可路由。默认镜像 isAvailable。
   */
  isExplicitlyAvailable(): Promise<boolean> | boolean {
    return this.isAvailable();
  }

  /** 执行搜索。凭据 MUST 经 env 通道（credentials.ts）解析。 */
  abstract search(params: SearchParams): Promise<SearchResponse>;
}
