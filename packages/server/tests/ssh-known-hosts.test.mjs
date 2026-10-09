import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { createKnownHostsTrust } = await import("../src/remote/sshKnownHosts.ts");
const { createSSHHostKeyVerifier } = await import("../src/remote/sshAuth.ts");

function keyFixture(label) {
  const bytes = Buffer.from(label);
  return {
    encoded: bytes.toString("base64"),
    hash: createHash("sha256").update(bytes).digest("hex"),
  };
}

test("known_hosts trust resolves matching SHA-256 fingerprint and rejects unknown host", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-known-hosts-"));
  const path = join(root, "known_hosts");
  try {
    const key = Buffer.from("fixture-public-key").toString("base64");
    const fingerprint = `SHA256:${createHash("sha256").update(Buffer.from(key, "base64")).digest("base64").replace(/=+$/u, "")}`;
    await writeFile(path, `example.test ssh-ed25519 ${key}\n`, "utf8");
    const trust = await createKnownHostsTrust(path);
    assert.equal(trust.resolve("example.test", 22), fingerprint);
    assert.equal(trust.resolve("other.test", 22), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("known_hosts accepts every approved algorithm and hashed non-default port, but rejects revoked keys", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acode-known-hosts-multiple-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "known_hosts");
  const a = keyFixture("key-a");
  const b = keyFixture("key-b");
  const c = keyFixture("key-c");
  const salt = Buffer.alloc(20, 7);
  const hashed = `|1|${salt.toString("base64")}|${createHmac("sha1", salt).update("[example.test]:2222").digest("base64")}`;
  await writeFile(
    path,
    [
      `example.test ssh-ed25519 ${a.encoded}`,
      `example.test ssh-rsa ${b.encoded}`,
      `${hashed} ssh-ed25519 ${c.encoded}`,
      `@revoked example.test ssh-ed25519 ${a.encoded}`,
      `@cert-authority example.test ssh-rsa ${c.encoded}`,
    ].join("\n"),
  );
  const trust = await createKnownHostsTrust(path);
  const verify = createSSHHostKeyVerifier({ host: "example.test", port: 22, trust });
  assert.equal(verify(a.hash), false, "revocation overrides an approved duplicate");
  assert.equal(verify(b.hash), true, "second approved algorithm remains usable");
  assert.equal(verify(c.hash), false, "CA records cannot approve raw host keys");
  assert.equal(createSSHHostKeyVerifier({ host: "example.test", port: 2222, trust })(c.hash), true);
  assert.equal(createSSHHostKeyVerifier({ host: "other.test", port: 2222, trust })(c.hash), false);

  await writeFile(path, "");
  await trust.refresh();
  assert.equal(verify(b.hash), false, "refresh must discard removed approvals");
});

test("known_hosts wildcard and negation patterns preserve host and port boundaries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acode-known-hosts-pattern-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "known_hosts");
  const key = keyFixture("pattern-key");
  await writeFile(
    path,
    `*.example.test,!blocked.example.test,alias.test ssh-ed25519 ${key.encoded}\n`,
  );
  const trust = await createKnownHostsTrust(path);
  const verify = (host, port = 22) => createSSHHostKeyVerifier({ host, port, trust })(key.hash);
  assert.equal(verify("allowed.example.test"), true);
  assert.equal(verify("ALIAS.TEST"), true);
  assert.equal(verify("blocked.example.test"), false);
  assert.equal(verify("allowed.example.test.attacker.test"), false);
  assert.equal(verify("allowed.example.test", 2222), false);
});

test("known_hosts read failure is unavailable and missing file is unknown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acode-known-hosts-unavailable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trust = await createKnownHostsTrust(join(root, "missing"));
  assert.equal(trust.resolve("example.test", 22), undefined);
  await assert.rejects(createKnownHostsTrust(root), { code: "ssh-host-key-trust-unavailable" });
});
