// Visualization Fragment Port - 对话内可视化片段的存储边界
//
// 三段式契约（apps/acode-cli/specs/gen-ui-visualize.md）里唯一的外部 IO 半边：
// 写入工具（core）经它落盘，v4 投影层经它的内存注册表核对引用，读取查询
// （conversationVisualizationRead）经它取字节。路径拼接、文件名消毒、注册表
// 重建（冷恢复从磁盘 ls）都住在 adapter 实现里；本端口只声明能力与副作用。

/** 注册表里一条片段的投影事实（artifactRow 的 sizeBytes/sha256/displayName 来源）。 */
export interface VisualizationFragmentMeta {
  /** 内容字节数（写入时实测；重建时按文件 stat）。 */
  bytes: number;
  /** 内容 sha256（hex，64 字符）。 */
  sha256: string;
  /** 写入时携带的卡片标题；冷恢复重建时缺席（displayName 回退 name）。 */
  displayName?: string;
}

export interface VisualizationFragmentStorePort {
  /**
   * 写入（同名覆盖 = 更新：新版本，旧引用继续读新内容）。
   * 唯一的注册者：写成功的同时登记进内存注册表，供投影层核对引用。
   */
  writeVisualizationFragment(input: {
    sessionId: string;
    name: string;
    content: string;
    title?: string;
  }): Promise<{ bytes: number }>;

  /** 读整份字节。返回 undefined = 该会话没有这个片段（授权链据此归一 not found）。 */
  readVisualizationFragment(input: {
    sessionId: string;
    name: string;
  }): Promise<Uint8Array | undefined>;

  /** 同步注册表查询（投影 reducer 是同步的，不能在收口处做 IO）。 */
  lookupVisualizationFragment(sessionId: string, name: string): VisualizationFragmentMeta | undefined;

  /**
   * 冷恢复重建：从存储目录枚举该会话的片段并回填注册表（displayName 不可恢复，
   * 回退 name）。幂等；在 hydration 喂事件之前调用。
   */
  rebuildVisualizationFragments(sessionId: string): Promise<void>;
}
