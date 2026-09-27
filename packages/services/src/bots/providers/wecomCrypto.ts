import { Buffer } from "node:buffer";
import { createDecipheriv, createHash } from "node:crypto";

// 企业微信回调加解密：EncodingAESKey(base64) → 32 字节 AES key，AES-256-CBC + PKCS7(block 32)。
// 明文结构：16 随机字节 + 4 字节网络序消息长度 + 消息体 + receiveid(corpid)。
const WECOM_PKCS7_BLOCK_SIZE = 32;

export interface WeComDecryptResult {
  message: string;
  receiveid: string;
}

/** 校验 msg_signature：SHA1(sort([token, timestamp, nonce, encrypt]).join(""))。 */
function computeWeComSignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypt: string,
): string {
  const sorted = [token, timestamp, nonce, encrypt].sort();
  return createHash("sha1").update(sorted.join("")).digest("hex");
}

export function verifyWeComSignature(
  expected: string,
  token: string,
  timestamp: string,
  nonce: string,
  encrypt: string,
): boolean {
  const computed = computeWeComSignature(token, timestamp, nonce, encrypt);
  // 等长定值比较避免时序侧信道；msg_signature 为 40 位 hex。
  if (computed.length !== expected.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < computed.length; index += 1) {
    diff |= computed.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return diff === 0;
}

function decodeWeComAesKey(encodingAESKey: string): Buffer {
  const trimmed = encodingAESKey.trim();
  // EncodingAESKey 固定 43 位 base64，补 "=" 后解码为 32 字节。
  const key = Buffer.from(`${trimmed}=`, "base64");
  if (key.length !== 32) {
    throw new Error("WeCom EncodingAESKey is invalid.");
  }
  return key;
}

/** 解密 base64 密文，返回明文消息体与 receiveid。 */
export function decryptWeComMessage(
  encodingAESKey: string,
  cipherBase64: string,
): WeComDecryptResult {
  const key = decodeWeComAesKey(encodingAESKey);
  const iv = key.subarray(0, 16);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  // 企业微信使用 block=32 的 PKCS7，Node 默认按 16 去填充会出错；关闭后手动去填充。
  decipher.setAutoPadding(false);
  let decrypted = Buffer.concat([
    decipher.update(Buffer.from(cipherBase64, "base64")),
    decipher.final(),
  ]);
  const padLength = decrypted[decrypted.length - 1] ?? 0;
  if (padLength >= 1 && padLength <= WECOM_PKCS7_BLOCK_SIZE) {
    decrypted = decrypted.subarray(0, decrypted.length - padLength);
  }
  const content = decrypted.subarray(16);
  const messageLength = content.readUInt32BE(0);
  if (messageLength < 0 || 4 + messageLength > content.length) {
    throw new Error("WeCom decrypted payload length is invalid.");
  }
  const message = content.subarray(4, 4 + messageLength).toString("utf8");
  const receiveid = content.subarray(4 + messageLength).toString("utf8");
  return { message, receiveid };
}

/** 读取企业微信 XML 节点值，兼容 CDATA 包裹。 */
export function readWeComXmlField(xml: string, field: string): string {
  const cdataMatch = xml.match(
    new RegExp(`<${field}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>)<\\/${field}>`, "u"),
  );
  if (cdataMatch?.[1] !== undefined) {
    return cdataMatch[1];
  }
  const plainMatch = xml.match(
    new RegExp(`<${field}>([\\s\\S]*?)<\\/${field}>`, "u"),
  );
  return plainMatch?.[1]?.trim() ?? "";
}
