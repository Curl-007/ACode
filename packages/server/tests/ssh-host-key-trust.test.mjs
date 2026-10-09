import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import ssh2 from "ssh2";
import {
  buildSSHConnectConfig,
  composeSSHHostKeyTrust,
  createSSHHostKeyVerifier,
  SSHHostKeyVerificationError,
} from "../src/remote/sshAuth.ts";
import { createKnownHostsTrust } from "../src/remote/sshKnownHosts.ts";
import { createManagedSSHHostKeyTrust } from "../src/remote/sshManagedTrust.ts";
import { SSHBackend } from "../src/remote/ssh-backend.ts";

const { Client, Server } = ssh2;

function makeHostKey() {
  return generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs1",
    format: "pem",
  });
}

async function startFakeSSHServer(hostKey) {
  let authAttempts = 0;
  let connections = 0;
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    connections += 1;
    client.on("error", () => undefined);
    client.on("authentication", (context) => {
      authAttempts += 1;
      if (
        context.method === "password" &&
        context.username === "alice" &&
        context.password === "secret"
      ) {
        context.accept();
      } else {
        context.reject();
      }
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("shell", (acceptShell) => acceptShell());
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    get authAttempts() {
      return authAttempts;
    },
    get connections() {
      return connections;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function connectAndWait(config, expectReady) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      client.removeAllListeners();
      if (error) reject(error);
      else resolve(value);
    };
    client.once("ready", () => {
      if (!expectReady) {
        client.end();
        finish(new Error("unexpected SSH ready"));
        return;
      }
      client.end();
      finish(undefined, true);
    });
    client.once("error", (error) => {
      if (expectReady) finish(error);
      else finish(undefined, error);
    });
    client.connect({ ...config, readyTimeout: 2_000 });
  });
}

test("unknown host key is rejected before password authentication", async () => {
  const server = await startFakeSSHServer(makeHostKey());
  try {
    const config = buildSSHConnectConfig({
      host: "127.0.0.1",
      port: server.port,
      username: "alice",
      password: "secret",
    });
    const error = await connectAndWait(config, false);
    assert.equal(server.authAttempts, 0);
    assert.match(String(error?.message), /Host denied|verification failed/i);
  } finally {
    await server.close();
  }
});

test("SSH backend refreshes revoked approvals before reconnect and coalesces concurrent handshakes", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-ssh-reconnect-"));
  const key = makeHostKey();
  const publicKey = ssh2.utils.parseKey(key).getPublicSSH().toString("base64");
  const server = await startFakeSSHServer(key);
  let backend;
  try {
    const path = join(root, "known_hosts");
    const record = `[127.0.0.1]:${server.port} ssh-rsa ${publicKey}`;
    await writeFile(path, record);
    backend = new SSHBackend({
      host: "127.0.0.1",
      port: server.port,
      username: "alice",
      password: "secret",
      hostKeyTrust: await createKnownHostsTrust(path),
    });
    await Promise.all([backend.ensureConnected(), backend.ensureConnected()]);
    assert.equal(server.connections, 1);
    const authBefore = server.authAttempts;
    const closed = once(backend.client, "close");
    backend.client.end();
    await closed;
    await writeFile(path, `${record}\n@revoked ${record}\n`);
    await assert.rejects(backend.ensureConnected(), { code: "ssh-host-key-revoked" });
    assert.equal(server.authAttempts, authBefore, "revocation must prevent another authentication");
  } finally {
    backend?.dispose();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("disposing SSH backend during trust refresh prevents late credential use", async () => {
  let release;
  const refresh = new Promise((resolve) => {
    release = resolve;
  });
  const backend = new SSHBackend({
    host: "127.0.0.1",
    port: 1,
    username: "alice",
    password: "secret",
    hostKeyTrust: { refresh: () => refresh, resolve: () => undefined },
  });
  const connecting = backend.ensureConnected();
  backend.dispose();
  release();
  await assert.rejects(connecting, /已释放/u);
});

test("same host key is accepted and changed key is rejected", async () => {
  const server = await startFakeSSHServer(makeHostKey());
  try {
    let observedHash;
    const firstConfig = buildSSHConnectConfig({
      host: "127.0.0.1",
      port: server.port,
      username: "alice",
      password: "secret",
    });
    firstConfig.hostVerifier = (keyHash) => {
      observedHash = keyHash;
      return false;
    };
    await connectAndWait(firstConfig, false);
    assert.ok(observedHash);

    const trustedConfig = buildSSHConnectConfig({
      host: "127.0.0.1",
      port: server.port,
      username: "alice",
      password: "secret",
      hostKeyTrust: { resolve: () => observedHash },
    });
    await connectAndWait(trustedConfig, true);
    assert.ok(server.authAttempts > 0);
    const trustedAuthAttempts = server.authAttempts;

    const changedConfig = buildSSHConnectConfig({
      host: "127.0.0.1",
      port: server.port,
      username: "alice",
      password: "secret",
      hostKeyTrust: { resolve: () => "SHA256:changed-key" },
    });
    await connectAndWait(changedConfig, false);
    assert.equal(
      server.authAttempts,
      trustedAuthAttempts,
      "changed key must fail before another auth attempt",
    );
  } finally {
    await server.close();
  }
});

test("trust verifier is fail-closed for missing and broken stores", () => {
  const statuses = [];
  const missing = createSSHHostKeyVerifier({
    host: "host",
    port: 22,
    onDecision: (status) => statuses.push(status),
  });
  assert.equal(missing("SHA256:key"), false);
  assert.equal(statuses.at(-1), "unavailable");

  const broken = createSSHHostKeyVerifier({
    host: "host",
    port: 22,
    trust: {
      resolve: () => {
        throw new Error("store offline");
      },
    },
    onDecision: (status) => statuses.push(status),
  });
  assert.equal(broken("SHA256:key"), false);
  assert.equal(statuses.at(-1), "unavailable");
  assert.equal(new SSHHostKeyVerificationError("unknown").code, "ssh-host-key-unknown");
  assert.equal(new SSHHostKeyVerificationError("revoked").code, "ssh-host-key-revoked");
});

test("known_hosts approved key authenticates with ssh2 hexadecimal hostHash", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-ssh-approved-"));
  const key = makeHostKey();
  const publicKey = ssh2.utils.parseKey(key).getPublicSSH().toString("base64");
  const server = await startFakeSSHServer(key);
  try {
    const path = join(root, "known_hosts");
    await writeFile(path, `[127.0.0.1]:${server.port} ssh-rsa ${publicKey}\n`);
    await connectAndWait(
      buildSSHConnectConfig({
        host: "127.0.0.1",
        port: server.port,
        username: "alice",
        password: "secret",
        hostKeyTrust: await createKnownHostsTrust(path),
      }),
      true,
    );
    assert.ok(server.authAttempts > 0);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

function fingerprintForPrivateKey(key) {
  const publicKey = ssh2.utils.parseKey(key).getPublicSSH();
  return `SHA256:${createHash("sha256")
    .update(publicKey)
    .digest("base64")
    .replace(/=+$/u, "")}`;
}

function keyFixture(label) {
  const bytes = Buffer.from(label);
  const encoded = bytes.toString("base64");
  return {
    encoded,
    hash: `SHA256:${createHash("sha256")
      .update(bytes)
      .digest("base64")
      .replace(/=+$/u, "")}`,
  };
}

test("candidate challenge is emitted before auth and reject never retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-ssh-challenge-deny-"));
  const key = makeHostKey();
  const server = await startFakeSSHServer(key);
  let backend;
  const challenges = [];
  try {
    const trust = await createManagedSSHHostKeyTrust(join(root, "ssh-host-trust.json"));
    backend = new SSHBackend({
      host: "127.0.0.1",
      port: server.port,
      username: "alice",
      password: "secret",
      hostKeyTrust: trust,
      onHostKeyChallenge: async (challenge) => {
        challenges.push(challenge);
        return {
          challengeId: challenge.challengeId,
          action: "reject",
          candidateFingerprint: challenge.candidateFingerprint,
        };
      },
    });
    await assert.rejects(backend.ensureConnected(), { code: "ssh-host-key-unknown" });
    assert.equal(challenges.length, 1);
    assert.equal(challenges[0].status, "unknown");
    assert.match(challenges[0].candidateFingerprint, /^SHA256:/u);
    assert.equal(server.authAttempts, 0, "challenge must precede authentication");
    assert.equal(server.connections, 1, "reject must not start a second handshake");
  } finally {
    backend?.dispose();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("approve persists the candidate and retries exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-ssh-challenge-approve-"));
  const key = makeHostKey();
  const server = await startFakeSSHServer(key);
  let backend;
  try {
    const trustPath = join(root, "ssh-host-trust.json");
    const trust = await createManagedSSHHostKeyTrust(trustPath);
    backend = new SSHBackend({
      host: "127.0.0.1",
      port: server.port,
      username: "alice",
      password: "secret",
      hostKeyTrust: trust,
      onHostKeyChallenge: async (challenge) => ({
        challengeId: challenge.challengeId,
        action: "approve",
        candidateFingerprint: challenge.candidateFingerprint,
      }),
    });
    await backend.ensureConnected();
    assert.equal(server.connections, 2, "one rejected probe plus one approved retry");
    assert.ok(server.authAttempts > 0);
    const persisted = await createManagedSSHHostKeyTrust(trustPath);
    assert.equal(persisted.resolve("127.0.0.1", server.port), fingerprintForPrivateKey(key));
  } finally {
    backend?.dispose();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("changed candidate requires replace and carries both old and new fingerprints", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-ssh-challenge-replace-"));
  const oldKey = makeHostKey();
  const newKey = makeHostKey();
  const server = await startFakeSSHServer(newKey);
  let deniedBackend;
  let approvedBackend;
  try {
    const trustPath = join(root, "ssh-host-trust.json");
    const trust = await createManagedSSHHostKeyTrust(trustPath);
    await trust.commitDecision(
      {
        challengeId: "seed-old",
        host: "127.0.0.1",
        port: server.port,
        status: "unknown",
        candidateFingerprint: fingerprintForPrivateKey(oldKey),
        expectedFingerprints: [],
      },
      "approve",
    );
    let observed;
    deniedBackend = new SSHBackend({
      host: "127.0.0.1",
      port: server.port,
      username: "alice",
      password: "secret",
      hostKeyTrust: await createManagedSSHHostKeyTrust(trustPath),
      onHostKeyChallenge: async (challenge) => {
        observed = challenge;
        return {
          challengeId: challenge.challengeId,
          action: "approve",
          candidateFingerprint: challenge.candidateFingerprint,
        };
      },
    });
    await assert.rejects(deniedBackend.ensureConnected(), { code: "ssh-host-key-decision-invalid" });
    assert.equal(server.authAttempts, 0, "invalid changed decision must not authenticate");
    assert.deepEqual(observed.expectedFingerprints, [fingerprintForPrivateKey(oldKey)]);
    assert.notEqual(observed.candidateFingerprint, observed.expectedFingerprints[0]);

    approvedBackend = new SSHBackend({
      host: "127.0.0.1",
      port: server.port,
      username: "alice",
      password: "secret",
      hostKeyTrust: await createManagedSSHHostKeyTrust(trustPath),
      onHostKeyChallenge: async (challenge) => ({
        challengeId: challenge.challengeId,
        action: "replace",
        candidateFingerprint: challenge.candidateFingerprint,
      }),
    });
    await approvedBackend.ensureConnected();
    assert.ok(server.authAttempts > 0);
    const persisted = await createManagedSSHHostKeyTrust(trustPath);
    assert.equal(persisted.resolve("127.0.0.1", server.port), fingerprintForPrivateKey(newKey));
  } finally {
    deniedBackend?.dispose();
    approvedBackend?.dispose();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("managed trust commits from two hosts are atomic and preserve both approvals", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-ssh-managed-concurrency-"));
  try {
    const trustPath = join(root, "ssh-host-trust.json");
    const first = await createManagedSSHHostKeyTrust(trustPath);
    const second = await createManagedSSHHostKeyTrust(trustPath);
    const challengeA = {
      challengeId: "concurrent-a",
      host: "alpha.example",
      port: 22,
      status: "unknown",
      candidateFingerprint: "SHA256:alpha",
      expectedFingerprints: [],
    };
    const challengeB = {
      challengeId: "concurrent-b",
      host: "beta.example",
      port: 22,
      status: "unknown",
      candidateFingerprint: "SHA256:beta",
      expectedFingerprints: [],
    };
    await Promise.all([
      first.commitDecision(challengeA, "approve"),
      second.commitDecision(challengeB, "approve"),
    ]);
    const persisted = await createManagedSSHHostKeyTrust(trustPath);
    assert.equal(persisted.resolve("alpha.example", 22), "SHA256:alpha");
    assert.equal(persisted.resolve("beta.example", 22), "SHA256:beta");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changed replacement can persist a known_hosts baseline into managed trust", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-ssh-managed-known-hosts-replace-"));
  try {
    const trustPath = join(root, "ssh-host-trust.json");
    const trust = await createManagedSSHHostKeyTrust(trustPath);
    await trust.commitDecision(
      {
        challengeId: "known-hosts-replace",
        host: "known-hosts.example",
        port: 22,
        status: "changed",
        candidateFingerprint: "SHA256:new-key",
        expectedFingerprints: ["SHA256:old-key"],
      },
      "replace",
    );
    assert.equal(trust.resolve("known-hosts.example", 22), "SHA256:new-key");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("composite trust keeps known_hosts revoked keys authoritative over managed approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-ssh-composite-revoked-"));
  try {
    const key = keyFixture("composite-revoked");
    const knownHostsPath = join(root, "known_hosts");
    const managedPath = join(root, "ssh-host-trust.json");
    await writeFile(
      knownHostsPath,
      [
        `example.test ssh-ed25519 ${key.encoded}`,
        `@revoked example.test ssh-ed25519 ${key.encoded}`,
      ].join("\n"),
    );
    const managed = await createManagedSSHHostKeyTrust(managedPath);
    await managed.commitDecision(
      {
        challengeId: "composite-revoked-seed",
        host: "example.test",
        port: 22,
        status: "unknown",
        candidateFingerprint: key.hash,
        expectedFingerprints: [],
      },
      "approve",
    );
    const composite = composeSSHHostKeyTrust(
      managed,
      await createKnownHostsTrust(knownHostsPath),
    );
    const statuses = [];
    const verifier = createSSHHostKeyVerifier({
      host: "example.test",
      port: 22,
      trust: composite,
      onDecision: (status) => statuses.push(status),
    });
    assert.equal(verifier(key.hash), false);
    assert.equal(statuses.at(-1), "revoked");
    assert.equal(
      composite.resolveCandidate("example.test", 22, key.hash).status,
      "revoked",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("composite trust rejects a managed approval that bypasses a known_hosts changed key", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-ssh-composite-changed-"));
  try {
    const oldKey = keyFixture("composite-old");
    const newKey = keyFixture("composite-new");
    const knownHostsPath = join(root, "known_hosts");
    const managedPath = join(root, "ssh-host-trust.json");
    await writeFile(knownHostsPath, `example.test ssh-ed25519 ${oldKey.encoded}\n`);
    const managed = await createManagedSSHHostKeyTrust(managedPath);
    await managed.commitDecision(
      {
        challengeId: "composite-changed-seed",
        host: "example.test",
        port: 22,
        status: "unknown",
        candidateFingerprint: newKey.hash,
        expectedFingerprints: [],
      },
      "approve",
    );
    const composite = composeSSHHostKeyTrust(
      managed,
      await createKnownHostsTrust(knownHostsPath),
    );
    const statuses = [];
    const verifier = createSSHHostKeyVerifier({
      host: "example.test",
      port: 22,
      trust: composite,
      onDecision: (status) => statuses.push(status),
    });
    assert.equal(verifier(newKey.hash), false);
    assert.equal(statuses.at(-1), "changed");
    assert.equal(
      composite.resolveCandidate("example.test", 22, newKey.hash).status,
      "changed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("composite trust permits only an explicit replace override for a known_hosts changed key", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-ssh-composite-replace-"));
  try {
    const oldKey = keyFixture("composite-replace-old");
    const newKey = keyFixture("composite-replace-new");
    const knownHostsPath = join(root, "known_hosts");
    const managedPath = join(root, "ssh-host-trust.json");
    await writeFile(knownHostsPath, `example.test ssh-ed25519 ${oldKey.encoded}\n`);
    const managed = await createManagedSSHHostKeyTrust(managedPath);
    const knownHosts = await createKnownHostsTrust(knownHostsPath);
    const composite = composeSSHHostKeyTrust(managed, knownHosts);
    assert.equal(
      composite.resolveCandidate("example.test", 22, newKey.hash).status,
      "changed",
    );
    await managed.commitDecision(
      {
        challengeId: "composite-replace",
        host: "example.test",
        port: 22,
        status: "changed",
        candidateFingerprint: newKey.hash,
        expectedFingerprints: [oldKey.hash],
      },
      "replace",
    );
    await composite.refresh?.();
    const resolution = composite.resolveCandidate("example.test", 22, newKey.hash);
    assert.equal(resolution.status, "trusted");
    assert.equal(resolution.allowKnownHostsOverride, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
