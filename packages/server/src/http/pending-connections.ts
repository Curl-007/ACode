import { randomUUID } from "node:crypto";
import type { RemoteConnection } from "../remote/index.js";

/**
 * 待认领条目 = 已建立的远程连接 + 其 spawn 完成时刻（惰性过期依据，见下方 TTL 注释）。
 * 唯一所有者是本 Map（specs/server-auth.md「待认领远程连接唯一所有者」）；2026-10-30
 * 自 http.ts 拆分后本文件即所有者本体，写入路径收敛为 register/claim/prune 三函数，
 * http.ts 本体不再直接持有 Map。写入仍只发生在 `/api/connect-remote`（经
 * registerPendingConnection），删除在认领（claimPendingConnection）或惰性过期
 * （pruneExpiredPendingConnections）时，不存在第二条写入路径。
 */
interface PendingRemoteConnection {
  connection: RemoteConnection;
  spawnedAt: number;
}

/** 存储 web 模式下的远程连接，key 为随机 ID */
const remoteConnections = new Map<string, PendingRemoteConnection>();

/**
 * 待认领（已 spawn 但尚未被 `/ws/remote/:id` WS 客户端认领）远程连接的硬上限（M11）。
 *
 * 根因：条目只在 WS 认领时删除，`POST /api/connect-remote` 又可被盲刷——每次成功都会
 * spawn 真实后端（SSH 外联 / WSL / Docker），未认领条目无限累积即内存与进程句柄 DoS。
 * Origin 裁决封死浏览器攻击者后，本上限是有界性兜底：达上限即 503 拒绝新连接。
 */
export const MAX_PENDING_REMOTE_CONNECTIONS = 32;

/**
 * 待认领连接的存活上限（惰性过期，R2 review 第三条 finding）。
 *
 * 根因：`POST /api/connect-remote` 成功后 id 已下发给客户端，客户端应立即连
 * `/ws/remote/:id` 认领；若客户端崩溃/放弃，条目连同其持有的真实后端句柄（SSH 进程、
 * stdio socket）永久滞留到进程重启——`MAX_PENDING_REMOTE_CONNECTIONS` 只兜住数量上限，
 * 慢泄漏（句柄/内存）仍在。
 *
 * 为什么用**惰性过期**而非常驻定时器：AGENTS.md 明确「不能用超时掩盖同步问题」——认领本身
 * 是同步的请求/响应链，不需要定时器兜底。这里做的是**有界资源回收**：在两个既有请求触点
 * （新连接的容量检查、认领时的存活校验）顺带清理已超期条目，不引入新的常驻定时器所有权，
 * 也不改变认领的同步语义。TTL 取 60s：远大于正常「拿到 id → WS 认领」的往返（秒级），
 * 又足够短以在客户端放弃后及时回收句柄。
 */
export const PENDING_REMOTE_CONNECTION_TTL_MS = 60_000;

/**
 * 判定一条待认领连接是否已超期（纯函数，便于边界单测）。
 * `>=` 而非 `>`：到达 TTL 当刻即视为失效，避免「恰好等于」的边界歧义。
 */
function isPendingConnectionExpired(spawnedAt: number, now: number, ttlMs: number): boolean {
  return now - spawnedAt >= ttlMs;
}

/**
 * 惰性驱逐：遍历待认领表，dispose 并移除已超期条目。
 * 由请求触点同步调用（容量检查 / 认领校验），无常驻定时器。dispose 失败只吞掉，
 * 不阻断本次请求——回收是尽力而为，句柄泄漏的兜底仍是进程退出。
 */
export function pruneExpiredPendingConnections(now: number, ttlMs: number): void {
  for (const [id, entry] of remoteConnections) {
    if (!isPendingConnectionExpired(entry.spawnedAt, now, ttlMs)) {
      continue;
    }
    remoteConnections.delete(id);
    try {
      entry.connection.dispose();
    } catch {
      // 过期条目 dispose 失败不阻断：条目已从表移除，句柄随进程退出回收。
    }
  }
}

/** 登记待认领连接；`spawnedAt` 记录 spawn 完成时刻作为惰性过期依据（R2 finding 3）。 */
export function registerPendingConnection(
  id: string,
  connection: RemoteConnection,
  spawnedAt: number,
): void {
  remoteConnections.set(id, { connection, spawnedAt });
}

/** 当前待认领条目数，供本体做容量检查（与 MAX_PENDING_REMOTE_CONNECTIONS 比较）。 */
export function getPendingConnectionCount(): number {
  return remoteConnections.size;
}

/**
 * 认领：从表移除并返回连接（一个连接只给一个 WS 客户端使用）。
 * 认领时校验 spawn 时间：超期条目按失效处理——dispose 句柄、从表移除、返回 null
 * （本体据此 close 4004）。与 prune 同一判定（isPendingConnectionExpired），
 * 避免陈旧连接被迟到客户端复活。
 */
export function claimPendingConnection(
  id: string,
  now: number,
  ttlMs: number,
): RemoteConnection | null {
  const entry = remoteConnections.get(id);
  if (!entry) {
    return null;
  }
  if (isPendingConnectionExpired(entry.spawnedAt, now, ttlMs)) {
    remoteConnections.delete(id);
    try {
      entry.connection.dispose();
    } catch {
      // 同 prune：dispose 失败不阻断拒绝路径。
    }
    return null;
  }
  remoteConnections.delete(id);
  return entry.connection;
}

/**
 * 待认领连接 id 生成：用 CSPRNG（`crypto.randomUUID`）而非 `Math.random`。
 * 修复依据：id 是 `/ws/remote/:id` 认领远程连接的唯一凭据，`Math.random` 序列可被
 * 预测——默认 loopback 无 token 姿态下，本机任意进程可猜 id 劫持他人待认领连接
 * （Mimosa 深扫高危线索；2026-10-30 自 http.ts 拆分随迁时修复，同文件 setupChannelServer
 * 的 connectionId 早已用 randomUUID，此处收敛为同一随机源）。
 */
export function generateId(): string {
  return randomUUID();
}
