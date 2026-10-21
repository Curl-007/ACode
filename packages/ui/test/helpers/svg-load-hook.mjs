// 拦截 .svg 导入的 Node module hook（ESM 钩子必须放 .mjs：CommonJS 文件无法声明
// resolve 钩子的具名导出形态）。
// Vite 的 assets.d.ts 把 *.svg 声明为默认导出 URL 字符串；Node 原生不认识 .svg 扩展，
// 会以 ERR_UNKNOWN_FILE_EXTENSION 拒绝加载。真实卡片树（WorkflowRunDigest →
// WorkflowRunSettingsPopover → … → oauthProviderIcon）深链到 provider 图标 svg，
// 单测只需要模块能加载，不消费位图，这里短路成占位字符串。
export async function resolve(specifier, context, next) {
  if (specifier.endsWith(".svg")) {
    return {
      shortCircuit: true,
      url: `data:text/javascript,export default ${JSON.stringify(specifier)}`,
    };
  }
  return next(specifier, context);
}
