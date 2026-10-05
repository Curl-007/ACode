// ============================================================
// CLI 宿主的 Open 平台端口实现（K9）
// ============================================================
// Open 工具的 R2 红线是「工具不 spawn 系统开箱命令、只经 platform port」——
// 本文件是**宿主侧**的 port 实现：由 CLI 宿主（而非 agent 工具）调用系统 opener。
// desktop host 后续接入 IPlatformService 下发链时替换此实现，工具面无感。
//
// 对抗复核 H1 修复（2026-10-04）：原先 Windows 形态经 `cmd /c start "" target`——
// cmd.exe 按 `"` 切换引号态，target 内嵌双引号可逃逸执行任意命令（execFile 的参数
// 数组形态只保证 argv 边界，**目标程序本身是 shell 时数组形态不构成防线**）。
// 现改用 explorer.exe 直传（非 shell，argv 经 CreateProcess 传递，无元字符解释层）；
// 上游 open.ts 执行面已同时改传 href 规范形（percent-encoded 后不含引号），双保险。

import { execFile } from "node:child_process";
import { platform } from "node:os";
import type { OpenPlatformPort } from "@acode/core";

function spawnSystemOpener(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error) => {
      // explorer.exe 即使成功打开也常返回非零退出码（历史行为），退出码不可用作
      // 成败判据——只有 spawn 层错误（找不到进程等）才判失败。
      if (error && (error as NodeJS.ErrnoException).code !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function openTarget(target: string, reveal: boolean): Promise<void> {
  if (platform() === "win32") {
    // explorer.exe <target> 开 URL（默认浏览器）/文件（默认应用）/目录（资源管理器）；
    // reveal 用 /select,<path> 定位。非 shell：内嵌 `"`/`&`/`^`/`%` 不被解释。
    return spawnSystemOpener("explorer.exe", reveal ? [`/select,${target}`] : [target]);
  }
  if (platform() === "darwin") {
    return spawnSystemOpener("open", reveal ? ["-R", target] : [target]);
  }
  // Linux 无统一的 reveal 等价物：定位降级为打开目标本身（xdg-open 对目录开文件管理器）。
  return spawnSystemOpener("xdg-open", [target]);
}

/** CLI 宿主 native opener：URL/文件/目录开箱 + reveal 定位，全平台覆盖。 */
export function createCliPlatformOpenPort(): OpenPlatformPort {
  return {
    openExternal: (url: string): void => {
      // void 契约（IPlatformService 同构）：fire-and-forget，错误只吞——
      // Open 工具的回执已由自身 try/catch 决定 opened 值，这里不叠加第二次错误面。
      void openTarget(url, false).catch(() => undefined);
    },
    openExternalFile: async (path: string, options?: { reveal?: boolean }) => {
      try {
        await openTarget(path, options?.reveal === true);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
