import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@acode/shared/node";
import {
  normalizeSSHHostKeyFingerprint,
  SSHHostKeyDecisionError,
  SSHHostKeyVerificationError,
  type SSHHostKeyChallenge,
  type SSHHostKeyDecisionAction,
  type SSHHostKeyTrust,
} from "./sshAuth.js";

const MANAGED_STORE_VERSION = 1 as const;

interface ManagedSSHHostKeyEntry {
  host: string;
  port: number;
  fingerprints: string[];
  /** Only an explicit changed-key replace may bypass a known_hosts baseline. */
  allowKnownHostsOverride: boolean;
}

interface ManagedSSHHostKeyFile {
  version: typeof MANAGED_STORE_VERSION;
  entries: ManagedSSHHostKeyEntry[];
}

function normalizeHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (!normalized) throw new SSHHostKeyDecisionError("SSH 主机名为空，无法保存主机密钥");
  return normalized;
}

function normalizePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new SSHHostKeyDecisionError("SSH 端口无效，无法保存主机密钥");
  }
  return port;
}

function entryKey(host: string, port: number): string {
  return `${normalizeHost(host)}\u0000${normalizePort(port)}`;
}

function parseEntries(value: unknown): ManagedSSHHostKeyEntry[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== MANAGED_STORE_VERSION ||
    !Array.isArray((value as { entries?: unknown }).entries)
  ) {
    throw new SSHHostKeyVerificationError("unavailable");
  }

  const byKey = new Map<string, ManagedSSHHostKeyEntry>();
  const rawEntries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(rawEntries)) {
    throw new SSHHostKeyVerificationError("unavailable");
  }
  for (const rawEntry of rawEntries) {
    if (typeof rawEntry !== "object" || rawEntry === null) {
      throw new SSHHostKeyVerificationError("unavailable");
    }
    const record = rawEntry as {
      host?: unknown;
      port?: unknown;
      fingerprints?: unknown;
      allowKnownHostsOverride?: unknown;
    };
    if (
      typeof record.host !== "string" ||
      !Number.isInteger(record.port) ||
      typeof record.fingerprints === "undefined" ||
      !Array.isArray(record.fingerprints)
    ) {
      throw new SSHHostKeyVerificationError("unavailable");
    }
    const host = normalizeHost(record.host);
    const port = normalizePort(record.port as number);
    const fingerprints = [
      ...new Set(
        record.fingerprints.map((fingerprint) => {
          if (typeof fingerprint !== "string") {
            throw new SSHHostKeyVerificationError("unavailable");
          }
          const normalized = normalizeSSHHostKeyFingerprint(fingerprint);
          if (!normalized) throw new SSHHostKeyVerificationError("unavailable");
          return normalized;
        }),
      ),
    ];
    if (fingerprints.length === 0) throw new SSHHostKeyVerificationError("unavailable");
    if (
      typeof record.allowKnownHostsOverride !== "undefined" &&
      typeof record.allowKnownHostsOverride !== "boolean"
    ) {
      throw new SSHHostKeyVerificationError("unavailable");
    }
    byKey.set(entryKey(host, port), {
      host,
      port,
      fingerprints,
      // Files written before candidate-aware trust did not have this field.
      allowKnownHostsOverride: record.allowKnownHostsOverride === true,
    });
  }
  return [...byKey.values()];
}

async function readManagedEntries(filePath: string): Promise<ManagedSSHHostKeyEntry[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw new SSHHostKeyVerificationError("unavailable");
  }
  try {
    return parseEntries(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof SSHHostKeyVerificationError) throw error;
    throw new SSHHostKeyVerificationError("unavailable");
  }
}

function serializeEntries(entries: readonly ManagedSSHHostKeyEntry[]): string {
  const file: ManagedSSHHostKeyFile = {
    version: MANAGED_STORE_VERSION,
    entries: entries.map((entry) => ({
      host: entry.host,
      port: entry.port,
      fingerprints: [...entry.fingerprints].sort(),
      allowKnownHostsOverride: entry.allowKnownHostsOverride,
    })),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

function cloneEntries(entries: readonly ManagedSSHHostKeyEntry[]): ManagedSSHHostKeyEntry[] {
  return entries.map((entry) => ({ ...entry, fingerprints: [...entry.fingerprints] }));
}

function assertChallengeFingerprint(challenge: SSHHostKeyChallenge): string {
  const candidate = normalizeSSHHostKeyFingerprint(challenge.candidateFingerprint);
  if (!candidate || candidate !== challenge.candidateFingerprint) {
    throw new SSHHostKeyDecisionError("SSH 主机密钥挑战候选与决策不匹配");
  }
  return candidate;
}

function findEntry(entries: readonly ManagedSSHHostKeyEntry[], challenge: SSHHostKeyChallenge) {
  const key = entryKey(challenge.host, challenge.port);
  return entries.find((entry) => entryKey(entry.host, entry.port) === key);
}

export function resolveManagedSSHHostKeyTrustPath(): string {
  const explicit = process.env["ACODE_SSH_TRUST_STORE"]?.trim();
  if (explicit) return explicit;
  const acodeHome = process.env["ACODE_HOME"]?.trim() || join(homedir(), ".acode");
  return join(acodeHome, "ssh-host-trust.json");
}

/**
 * A host-owned, cross-process SSH trust store. Reads are snapshot based for the
 * synchronous ssh2 verifier; every decision re-reads under the shared file lock
 * before replacing the file atomically.
 */
export async function createManagedSSHHostKeyTrust(
  filePath = resolveManagedSSHHostKeyTrustPath(),
): Promise<SSHHostKeyTrust> {
  let entries = await readManagedEntries(filePath);
  return {
    async refresh() {
      entries = await readManagedEntries(filePath);
    },
    resolve(host, port) {
      const entry = entries.find((candidate) => entryKey(candidate.host, candidate.port) === entryKey(host, port));
      if (!entry) return undefined;
      return entry.fingerprints.length === 1 ? entry.fingerprints[0] : [...entry.fingerprints];
    },
    resolveCandidate(host, port, candidateFingerprint) {
      const candidate = normalizeSSHHostKeyFingerprint(candidateFingerprint);
      if (!candidate) return { status: "unavailable", expectedFingerprints: [] };
      const entry = entries.find((item) => entryKey(item.host, item.port) === entryKey(host, port));
      if (!entry) return { status: "unknown", expectedFingerprints: [] };
      return {
        status: entry.fingerprints.includes(candidate) ? "trusted" : "changed",
        expectedFingerprints: [...entry.fingerprints],
        allowKnownHostsOverride: entry.allowKnownHostsOverride,
      };
    },
    async commitDecision(challenge, action: Exclude<SSHHostKeyDecisionAction, "reject">) {
      const candidate = assertChallengeFingerprint(challenge);
      if (challenge.status === "unknown" && action !== "approve") {
        throw new SSHHostKeyDecisionError("未知 SSH 主机密钥只能执行 approve");
      }
      if (challenge.status === "changed" && action !== "replace") {
        throw new SSHHostKeyDecisionError("变化的 SSH 主机密钥必须显式 replace");
      }
      const expected = [...new Set(challenge.expectedFingerprints.map(normalizeSSHHostKeyFingerprint))];
      await withFileLock(filePath, async () => {
        const current = await readManagedEntries(filePath);
        const existing = findEntry(current, challenge);
        const currentFingerprints = existing?.fingerprints ?? [];
        if (currentFingerprints.includes(candidate)) {
          if (challenge.status === "changed" && action === "replace" && existing) {
            const index = current.indexOf(existing);
            if (!existing.allowKnownHostsOverride) {
              current[index] = { ...existing, allowKnownHostsOverride: true };
              await atomicWritePrivateTextFile(filePath, serializeEntries(current));
            }
          }
          entries = cloneEntries(current);
          return;
        }

        if (challenge.status === "unknown") {
          if (currentFingerprints.length > 0) {
            throw new SSHHostKeyDecisionError("SSH 主机密钥挑战已过期，目标已有其他批准记录");
          }
          current.push({
            host: normalizeHost(challenge.host),
            port: normalizePort(challenge.port),
            fingerprints: [candidate],
            allowKnownHostsOverride: false,
          });
        } else {
          // changed 挑战也可能来自只读 known_hosts；此时 managed store 尚无该 host，
          // 但 challenge.expectedFingerprints 仍是认证前刷新得到的旧基线。允许把候选
          // 作为 managed 覆盖写入，同时要求 challenge 带有非空旧指纹；若 managed 已有
          // 记录，仍必须逐项匹配，防止并发 writer 让旧 challenge 覆盖新批准。
          if (
            expected.length === 0 ||
            (currentFingerprints.length > 0 &&
              expected.some((fingerprint) => !currentFingerprints.includes(fingerprint)))
          ) {
            throw new SSHHostKeyDecisionError("SSH 主机密钥变更挑战已过期，旧指纹不再匹配");
          }
          if (existing) {
            const index = current.indexOf(existing);
            current[index] = {
              host: existing.host,
              port: existing.port,
              fingerprints: [candidate],
              allowKnownHostsOverride: true,
            };
          } else {
            current.push({
              host: normalizeHost(challenge.host),
              port: normalizePort(challenge.port),
              fingerprints: [candidate],
              allowKnownHostsOverride: true,
            });
          }
        }
        await atomicWritePrivateTextFile(filePath, serializeEntries(current));
        entries = cloneEntries(current);
      });
    },
  };
}
