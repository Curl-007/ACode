/**
 * A1 READY 期 backend（specs/windows-helper-producer.md §2.4/§4.6）：仅注册 broker_info handler。
 *
 * 14 工具方法一个 handler 都不注册——unimplemented 由 dispatch 层统一产出（§4.6，wire spec
 * §9.2 裁决），绝不返回空树/空结果冒充成功（C09 红线 / 能力真实性纪律）。
 */
import { BROKER_INFO_METHOD, type BackendRecord } from "./wire-server.js";

/**
 * broker_info 最小诚实面（§4.6）：pid 是 health 门的 load-bearing 字段（宿主 isExactHealthPid
 * 只校 pid）；bundle_id 按 wire spec §6.2 Windows 取值规则 2 = canonical exe 绝对路径
 * （process.execPath）——规则 1（AUMID）对 fork 出的 node-mode 进程不适用。
 * richer 字段（version/kind/display_name/capabilities）延后至阶段 5 staging 布局裁决
 * （§8 openQuestion #4）：A1 不猜测、不读可能不存在的文件。
 */
export interface BrokerInfoResult {
  pid: number;
  bundle_id: string;
}

export function createBackendA1(): BackendRecord {
  const backend: BackendRecord = {};
  backend[BROKER_INFO_METHOD] = (): BrokerInfoResult => ({
    pid: process.pid,
    bundle_id: process.execPath,
  });
  return backend;
}
