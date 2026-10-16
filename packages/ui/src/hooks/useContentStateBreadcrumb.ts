/**
 * useContentStateBreadcrumb —— renderer 内容状态面包屑的周期上报 hook
 * （specs/main-stall-diagnostics.md R11，desktop 包 spec）。
 *
 * 挂载点（app-shell）注入两件事：
 * - `sample`：从 tab/session store 折算当前内容状态（route kind / transcript 消息
 *   数 / composer 块数 / 持有行数），每 tick 调用；
 * - `send`：wire transport（已接线：app-shell 装配层经 IPlatformService.sendContentBreadcrumb
 *   走 preload send-only 通道 "acode:content-breadcrumb"；桥缺席时 enabled:false 零副作用）。
 *
 * sample/send 用 ref 持有最新引用：调用方无需 useCallback 包裹，interval 也不会
 * 因渲染而重启。诊断设施 fail-open：采样/发送抛错静默跳过，不影响 UI。
 */
import { useEffect, useRef } from "react";
import {
  createContentStateBreadcrumbReporter,
  type ContentBreadcrumbWirePayload,
  type ContentStateSample,
} from "@/lib/contentStateBreadcrumb.js";

export interface UseContentStateBreadcrumbOptions {
  sample: () => ContentStateSample;
  send: (payload: ContentBreadcrumbWirePayload) => void;
  /** 上报周期（默认 5s）；每 tick 重发（main 侧 stamp age 只反映上报器停摆）。 */
  intervalMs?: number;
  /** 关闭上报（如隐私模式）；关闭期间 main 侧 stamp age 自然拉大，属预期。 */
  enabled?: boolean;
}

export function useContentStateBreadcrumb(options: UseContentStateBreadcrumbOptions): void {
  const { sample, send, intervalMs, enabled = true } = options;
  const sampleRef = useRef(sample);
  const sendRef = useRef(send);

  useEffect(() => {
    sampleRef.current = sample;
    sendRef.current = send;
  });

  useEffect(() => {
    if (!enabled) return;
    const reporter = createContentStateBreadcrumbReporter({
      sample: () => sampleRef.current(),
      send: (payload) => sendRef.current(payload),
      intervalMs,
    });
    reporter.start();
    return () => reporter.stop();
  }, [enabled, intervalMs]);
}
