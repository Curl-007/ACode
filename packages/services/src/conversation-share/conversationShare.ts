/**
 * 分享发布/导入相关契约（conversation-export 专用薄包装）。
 *
 * ACode1 当前没有完整的 conversation-share 落地；为让 conversationExportService
 * 编译通过，stub 出一个最小实现：声明 ConversationShareServiceError 子类与其构造签名，
 * 其它分享面（service descriptor / 输入输出 / 失败分类）暂留 TODO。
 *
 * 后续接 conversation-share 时，把此文件覆盖为完整版本即可，调用面契约与 anker-code 一致。
 */

export type ConversationShareServiceErrorKind = string;

export class ConversationShareServiceError extends Error {
  readonly kind: ConversationShareServiceErrorKind;
  constructor(kind: ConversationShareServiceErrorKind, message: string) {
    super(message);
    this.name = "ConversationShareServiceError";
    this.kind = kind;
  }
}
