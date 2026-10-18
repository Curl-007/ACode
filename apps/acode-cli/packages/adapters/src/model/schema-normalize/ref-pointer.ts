// Ported from oh-my-pi (MIT) — packages/omptype/src/local-ref.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// 本地 $ref URI fragment（RFC 6901 JSON Pointer）解析/编码
// ============================================================
// spec: apps/acode-cli/specs/tool-schema-normalize.md R7（omptype 解耦对照）。
// omp 把这对 helper 放在 omptype 包里供 schema importer 与 pi-ai 解析器共用；
// ACode 不引入 omptype，就地移植，语义逐字保留：percent 解码、`~1`/`~0` 反转义、
// 非本地 ref 与解码失败返回 undefined。

/**
 * 把本地 `$ref` URI fragment 解析为已解码的 JSON Pointer token 序列：
 * percent-decode → 按 `/` 切分 → 逐 token 反转义 `~1`/`~0`。
 * 根引用 `#` 返回 `[]`；非本地 ref 或 percent 解码失败返回 `undefined`。
 */
export function parseLocalRefPointer(ref: string): string[] | undefined {
  if (!ref.startsWith("#")) return undefined;
  let pointer: string;
  try {
    pointer = decodeURIComponent(ref.slice(1));
  } catch {
    return undefined;
  }
  if (pointer.length > 0 && !pointer.startsWith("/")) return undefined;
  return pointer
    .split("/")
    .slice(1)
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * 把 JSON Pointer token 序列编码回本地 `$ref` URI fragment——
 * {@link parseLocalRefPointer} 的逆变换。
 */
export function formatLocalRefPointer(tokens: readonly string[]): string {
  if (tokens.length === 0) return "#";
  // `$` 与其他被 encodeURIComponent 转义的 URI sub-delims 在 fragment 中合法，
  // 还原以保持 `$defs` 可读；`%` 保持编码以支持往返。
  const encoded = tokens
    .map((token) => encodeURIComponent(token.replace(/~/g, "~0").replace(/\//g, "~1")))
    .map((token) => token.replace(/%24/g, "$"));
  return `#/${encoded.join("/")}`;
}
