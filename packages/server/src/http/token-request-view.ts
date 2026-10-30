import type { Context } from "hono";
import { formatLogPrefix } from "@acode/shared";
import type { ServerTokenRequestView } from "@acode/shared/node";

/**
 * hono Context → 共享 token 裁决的请求视图。
 *
 * 裁决本体（凭据接受顺序 Bearer > lite token cookie > query 仅 `/ws*`、cookie 名与安全解码、
 * 受保护路径判定）已收敛到 `@acode/shared/node` serverAuth 的 `resolveServerTokenAuth` /
 * `readPresentedServerToken` / `isTokenProtectedPathname`，与 Server Core 共用单一实现；
 * 本文件只保留这一层 Context 适配，不再维护第二份接受顺序或 cookie 解码。
 */
export function serverTokenRequestView(c: Context): ServerTokenRequestView {
  return {
    authorizationHeader: c.req.header("authorization"),
    cookieHeader: c.req.header("cookie"),
    url: c.req.url,
  };
}

// `?token=` 移除告警每进程只打印一次，避免刷屏，同时确保旧客户端能被明确告知迁移路径。
let warnedDeprecatedQueryToken = false;
export function warnDeprecatedQueryTokenOnce(): void {
  if (warnedDeprecatedQueryToken) return;
  warnedDeprecatedQueryToken = true;
  console.warn(
    formatLogPrefix("acode-server:http", process.pid),
    "DEPRECATION REMOVED: the ?token= URL query is no longer accepted on HTTP routes and the request was rejected (it leaks into logs, browser history and Referer). Send `Authorization: Bearer <token>` instead. The query form remains supported only for WebSocket upgrade handshakes (/ws*), which cannot carry custom headers.",
  );
}
