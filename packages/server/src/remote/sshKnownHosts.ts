import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  normalizeSSHHostKeyFingerprint,
  SSHHostKeyVerificationError,
  type SSHHostKeyTrust,
} from "./sshAuth.js";

function normalizeHostToken(host: string, port: number): string {
  return port === 22 ? host.toLowerCase() : `[${host}]:${port}`.toLowerCase();
}

function fingerprintFromKnownHostsKey(keyType: string, encodedKey: string): string | undefined {
  if (!/^(?:ssh-|ecdsa-|sk-)/u.test(keyType) || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encodedKey)) {
    return undefined;
  }
  return `SHA256:${createHash("sha256").update(Buffer.from(encodedKey, "base64")).digest("base64").replace(/=+$/u, "")}`;
}

function matchesHostPattern(pattern: string, wanted: string): boolean {
  if (pattern.startsWith("|")) {
    const parts = pattern.split("|");
    if (parts.length !== 4 || parts[1] !== "1" || !parts[2] || !parts[3]) return false;
    const salt = Buffer.from(parts[2], "base64");
    const expected = Buffer.from(parts[3], "base64");
    if (salt.length !== 20 || expected.length !== 20) return false;
    const actual = createHmac("sha1", salt).update(wanted).digest();
    return timingSafeEqual(actual, expected);
  }
  const normalized = pattern.toLowerCase();
  let patternAt = 0;
  let hostAt = 0;
  let starAt = -1;
  let starEnd = 0;
  // 只解释 OpenSSH 的 * 和 ?，不把主机字段作为正则表达式执行。
  while (hostAt < wanted.length) {
    if (normalized[patternAt] === "?" || normalized[patternAt] === wanted[hostAt]) {
      patternAt += 1;
      hostAt += 1;
    } else if (normalized[patternAt] === "*") {
      starAt = patternAt++;
      starEnd = hostAt;
    } else if (starAt >= 0) {
      patternAt = starAt + 1;
      hostAt = ++starEnd;
    } else {
      return false;
    }
  }
  while (normalized[patternAt] === "*") patternAt += 1;
  return patternAt === normalized.length;
}

function matchesHostField(field: string, wanted: string): boolean {
  const patterns = field.split(",");
  if (
    patterns.some(
      (pattern) => pattern.startsWith("!") && matchesHostPattern(pattern.slice(1), wanted),
    )
  ) {
    return false;
  }
  return patterns.some(
    (pattern) => !pattern.startsWith("!") && matchesHostPattern(pattern, wanted),
  );
}

/** 当前连接的只读 OpenSSH known_hosts 快照；读取在认证前异步完成。 */
async function readKnownHostsEntries(filePath: string) {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") content = "";
    else throw new SSHHostKeyVerificationError("unavailable");
  }
  return content.split(/\r?\n/u).flatMap((line) => {
    const fields = line.trim().split(/\s+/u);
    if (!fields[0] || fields[0].startsWith("#")) return [];
    const marker = fields[0].startsWith("@") ? fields.shift() : undefined;
    if (marker !== undefined && marker !== "@revoked") return [];
    const [hosts, keyType, key] = fields;
    if (!hosts || !keyType || !key) return [];
    const fingerprint = fingerprintFromKnownHostsKey(keyType, key);
    return fingerprint ? [{ hosts, fingerprint, revoked: marker === "@revoked" }] : [];
  });
}

export async function createKnownHostsTrust(
  filePath = process.env["ACODE_SSH_KNOWN_HOSTS"]?.trim() || join(homedir(), ".ssh", "known_hosts"),
): Promise<SSHHostKeyTrust> {
  let entries = await readKnownHostsEntries(filePath);
  return {
    async refresh() {
      // 刷新失败时先清空旧批准记录，不能让下一次连接误用缓存的撤销前状态。
      entries = [];
      entries = await readKnownHostsEntries(filePath);
    },
    resolve(host, port) {
      const wanted = normalizeHostToken(host, port);
      const matching = entries.filter((entry) => matchesHostField(entry.hosts, wanted));
      const revoked = new Set(
        matching.filter((entry) => entry.revoked).map((entry) => entry.fingerprint),
      );
      // 同一 host 可同时批准多种算法或轮换期密钥；不能只取首行导致合法 key 被误拒。
      // revoked 优先于普通受信行，即使同一 key 重复出现也不得重新批准。
      const approved = [
        ...new Set(
          matching
            .filter((entry) => !entry.revoked && !revoked.has(entry.fingerprint))
            .map((entry) => entry.fingerprint),
        ),
      ];
      return approved.length > 1 ? approved : approved[0];
    },
    resolveCandidate(host, port, candidateFingerprint) {
      const candidate = normalizeSSHHostKeyFingerprint(candidateFingerprint);
      if (!candidate) return { status: "unavailable", expectedFingerprints: [] };
      const wanted = normalizeHostToken(host, port);
      const matching = entries.filter((entry) => matchesHostField(entry.hosts, wanted));
      if (matching.length === 0) return { status: "unknown", expectedFingerprints: [] };

      const revoked = new Set(
        matching.filter((entry) => entry.revoked).map((entry) => entry.fingerprint),
      );
      const approved = [
        ...new Set(
          matching
            .filter((entry) => !entry.revoked && !revoked.has(entry.fingerprint))
            .map((entry) => entry.fingerprint),
        ),
      ];
      if (revoked.has(candidate)) {
        return {
          status: "revoked",
          expectedFingerprints: approved,
        };
      }
      return {
        status: approved.includes(candidate) ? "trusted" : "changed",
        expectedFingerprints: approved,
      };
    },
  };
}
