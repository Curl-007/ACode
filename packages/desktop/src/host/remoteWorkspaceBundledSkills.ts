/**
 * remote workspace 的「内置技能」分组组装（specs/skills-bundled-visibility-and-official-cache-authority.md I1）。
 *
 * 为什么单独成文件：remoteWorkspaceServiceCollection.ts 受架构 legacy ratchet（max-file-lines
 * 400，只减不增）约束，bundled 分组的组装逻辑与设计说明内联会超限；抽出为独立 helper 也让
 * 「远端 stub + 本机 bundled lister」的组合语义有单一落点。
 *
 * 设计（spec I1 remote 落地形态）：
 * - bundled 资源随 desktop 内容包分发，与官方预置子智能体（ISubagentsService 的
 *   bundledAgentsRoot）同一先例：remote workspace 也读 desktop 本机资源定位链
 *   （resolveBundledSkillsRoot，与 host/index.ts 注入 createLocalServices 的 bundledSkillsRoot
 *   同源同写法）。解析不到时为 undefined，按缺省姿态降级：设置页不显示「内置技能」分组、
 *   不报错、不伪造条目（R1）。
 * - remote workspace 的 ISkillsService 是远端 stub：项目级/用户级/插件技能位于远端文件系统，
 *   不能拿本机服务拿远端 workspacePath 去本机目录扫描；而远端机器上的服务装配未注入
 *   bundledSkillsRoot，永不产出 scope:"bundled" 条目。因此 list 结果中的 bundled 分组由本机
 *   lister 单独列出后并入（scope 双向过滤：远端结果中的 bundled 条目被替换、本机 lister 的
 *   非 bundled 条目被丢弃，远端数据零丢失），其余方法语义全在远端事实源，原样转发。
 * - bundled 清单唯一所有者仍是 skillsService discoverSkills（spec §二），这里只组装消费，
 *   不复制第二份扫描实现。
 */
import type { ISkillsService } from "@acode/services";
import { createSkillsService, resolveBundledSkillsRoot } from "@acode/services/node";

export function decorateSkillsServiceWithLocalBundled(
  remoteSkillsService: ISkillsService,
): ISkillsService {
  const bundledSkillsRoot = resolveBundledSkillsRoot();
  const bundledSkillsLister = bundledSkillsRoot
    ? createSkillsService({ isDesktopRuntime: true, bundledSkillsRoot })
    : undefined;
  return {
    ...remoteSkillsService,
    list: async (params) => {
      const remote = await remoteSkillsService.list(params);
      if (!bundledSkillsLister) {
        return remote;
      }
      const bundled = (await bundledSkillsLister.list(params)).skills.filter(
        (skill) => skill.scope === "bundled",
      );
      return {
        ...remote,
        skills: [...remote.skills.filter((skill) => skill.scope !== "bundled"), ...bundled],
      };
    },
  };
}
