import type { SubagentPort } from "@acode/contracts";

/**
 * 一次性会话前台策略的 port 包装（specs/subagent-background-tristate.md R3）。
 *
 * -p 一次性进程在最终消息后退出，后台子代理随进程消亡、结果静默丢失——该形态下
 * 「后台」语义不成立。会话形态只有装配入口（prompt-command）知道，runner 不感知
 * 形态；本 wrapper 是 port 层的唯一强制点：launch 请求进入 dispatch 前把三态
 * 重写为前台（runInBackground=false），同时压过 profile.background 默认与显式 true。
 * autoBackgroundMs 的压制在 createDefaultSubagentPort 的构造参数处（同一策略位）。
 *
 * 纯函数、可单测；是否应用由 config.subagents.backgroundPolicy 决定（缺省 honor
 * 不包装，交互式会话零变化）。
 *
 * 签名刻意收紧为 SubagentPort → SubagentPort（Review E2E finding 2）：实现是自有
 * 可枚举属性展开，只对对象字面量形态的 port 成立（当前唯一实现
 * createExploreSubagentPort）；class/原型方法实现会静默丢失 launch 以外的方法，
 * 不要把本包装当通用装饰器复用。
 */
export function wrapSubagentPortWithForegroundPolicy(port: SubagentPort): SubagentPort {
  return {
    ...port,
    launch: (request, options) => port.launch({ ...request, runInBackground: false }, options),
  };
}
