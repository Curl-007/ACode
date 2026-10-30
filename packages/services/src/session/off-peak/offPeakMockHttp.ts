/* off-peak mock 网关的 HTTP 读写小助手：JSON 应答与请求体解析。
   原为 offPeakMockGateway.ts 内联函数，供 ticket/messages 处理器叶子共用。 */
import type { IncomingMessage, ServerResponse } from "node:http";

export function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}
