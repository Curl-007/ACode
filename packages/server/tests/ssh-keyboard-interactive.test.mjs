// keyboard-interactive 安全应答测试（spec: packages/server/specs/ssh-prompt-mediation.md
// 验收场景 1-4 + R2 语义词表）。沿用 ssh-host-key-trust.test.mjs 的本地回环假
// SSH server 形态，不依赖真实 SSH 服务器。
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import ssh2 from "ssh2";
import {
  buildSSHConnectConfig,
  createKeyboardInteractiveResponder,
  normalizeSSHConnectError,
} from "../src/remote/sshAuth.ts";
import {
  classifyKeyboardInteractivePrompt,
  describeSSHKeyboardInteractiveRefusal,
  SSHKeyboardInteractiveRefusalError,
} from "../src/remote/sshKeyboardInteractive.ts";

const { Client, Server } = ssh2;

function makeHostKey() {
  return generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs1",
    format: "pem",
  });
}

/**
 * 假 SSH server：拒绝 password 方法并指向 keyboard-interactive，
 * 按场景发出提示；记录服务端实际收到的应答集。
 */
async function startKeyboardInteractiveServer(hostKey, scenario) {
  const state = { receivedResponses: [], connections: 0 };
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    state.connections += 1;
    client.on("error", () => undefined);
    client.on("authentication", (context) => {
      if (context.method === "keyboard-interactive") {
        context.prompt(scenario.prompts, (responses) => {
          state.receivedResponses.push(responses);
          if (scenario.accept?.(responses)) {
            context.accept();
          } else {
            context.reject();
          }
        });
        return;
      }
      if (context.method === "password") {
        // 模拟「只开 keyboard-interactive」的主机：密码方法拒绝并指路。
        context.reject(["keyboard-interactive"]);
        return;
      }
      context.reject();
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
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function connectWithResponder(port, responder) {
  return new Promise((resolve, reject) => {
    const config = buildSSHConnectConfig({
      host: "127.0.0.1",
      port,
      username: "alice",
      password: "secret",
    });
    // 聚焦 keyboard-interactive：host key 信任机制由 ssh-host-key-trust.test.mjs 覆盖。
    config.hostVerifier = () => true;
    const client = new Client();
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      client.removeAllListeners();
      if (error) reject(error);
      else resolve(value);
    };
    client.on("keyboard-interactive", responder);
    client.once("ready", () => {
      client.end();
      finish(undefined, true);
    });
    client.once("error", (error) => finish(error, undefined));
    client.connect({ ...config, readyTimeout: 5_000 });
  });
}

test("single password-semantic prompt is still answered with the connection password", async () => {
  const server = await startKeyboardInteractiveServer(makeHostKey(), {
    prompts: [{ prompt: "Password: ", echo: false }],
    accept: (responses) => responses.length === 1 && responses[0] === "secret",
  });
  try {
    const responder = createKeyboardInteractiveResponder("secret");
    await connectWithResponder(server.port, responder);
    assert.deepEqual(server.state.receivedResponses, [["secret"]]);
    assert.equal(responder.takeLastRefusal(), undefined);
  } finally {
    await server.close();
  }
});

test("multi-prompt batch is refused and the password never reaches the server", async () => {
  const server = await startKeyboardInteractiveServer(makeHostKey(), {
    prompts: [
      { prompt: "Password: ", echo: false },
      { prompt: "Verification code: ", echo: false },
    ],
  });
  try {
    const refusals = [];
    const responder = createKeyboardInteractiveResponder("secret", {
      onRefusal: (refusal) => refusals.push(refusal),
    });
    const error = await connectWithResponder(server.port, responder).then(
      () => undefined,
      (cause) => cause,
    );
    assert.ok(error, "authentication must fail instead of blindly answering");
    assert.deepEqual(server.state.receivedResponses, [[]]);
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0].reason, "multi_prompt");
    const taken = responder.takeLastRefusal();
    assert.equal(taken?.reason, "multi_prompt");
    assert.equal(responder.takeLastRefusal(), undefined, "takeLastRefusal must clear");
    // 错误通道形态：normalizeSSHConnectError 带 context 时升级为解释性拒绝错误。
    const normalized = normalizeSSHConnectError(error, { keyboardInteractiveRefusal: taken });
    assert.ok(normalized instanceof SSHKeyboardInteractiveRefusalError);
    assert.equal(normalized.code, "ssh-keyboard-interactive-refused");
    assert.equal(normalized.reason, "multi_prompt");
    // 不带 context（现行 SSHBackend 调用形态）行为不变。
    const legacy = normalizeSSHConnectError(error);
    assert.ok(!(legacy instanceof SSHKeyboardInteractiveRefusalError));
  } finally {
    await server.close();
  }
});

test("single OTP prompt is refused without answering the password", async () => {
  const server = await startKeyboardInteractiveServer(makeHostKey(), {
    prompts: [{ prompt: "Enter OTP code: ", echo: false }],
  });
  try {
    const responder = createKeyboardInteractiveResponder("secret");
    await connectWithResponder(server.port, responder).then(
      () => undefined,
      () => undefined,
    );
    assert.deepEqual(server.state.receivedResponses, [[]]);
    const refusal = responder.takeLastRefusal();
    assert.equal(refusal?.reason, "second_factor_prompt");
    assert.match(
      describeSSHKeyboardInteractiveRefusal(refusal),
      /一次性验证码|双因素/u,
    );
  } finally {
    await server.close();
  }
});

test("echo=true prompt (Username-style) never receives the password", async () => {
  const server = await startKeyboardInteractiveServer(makeHostKey(), {
    prompts: [{ prompt: "Username: ", echo: true }],
  });
  try {
    const responder = createKeyboardInteractiveResponder("secret");
    await connectWithResponder(server.port, responder).then(
      () => undefined,
      () => undefined,
    );
    assert.deepEqual(server.state.receivedResponses, [[]]);
    assert.equal(responder.takeLastRefusal()?.reason, "unrecognized_prompt");
  } finally {
    await server.close();
  }
});

test("mediator port answers a non-password prompt when it returns a value", async () => {
  const server = await startKeyboardInteractiveServer(makeHostKey(), {
    prompts: [{ prompt: "Enter OTP code: ", echo: false }],
    accept: (responses) => responses.length === 1 && responses[0] === "654321",
  });
  try {
    const mediatorRequests = [];
    const responder = createKeyboardInteractiveResponder("secret", {
      mediator: {
        async requestSecretPrompt(request) {
          mediatorRequests.push(request);
          return { answered: true, value: "654321" };
        },
      },
    });
    await connectWithResponder(server.port, responder);
    assert.deepEqual(server.state.receivedResponses, [["654321"]]);
    assert.equal(mediatorRequests.length, 1);
    assert.equal(mediatorRequests[0].kind, "otp");
    assert.equal(mediatorRequests[0].secret, true);
    assert.equal(mediatorRequests[0].text, "Enter OTP code:");
    assert.equal(responder.takeLastRefusal(), undefined);
  } finally {
    await server.close();
  }
});

test("mediator abort falls back to the refusal path and records the abort reason", async () => {
  const server = await startKeyboardInteractiveServer(makeHostKey(), {
    prompts: [{ prompt: "Enter passphrase for key 'id_ed25519': ", echo: false }],
  });
  try {
    const responder = createKeyboardInteractiveResponder("secret", {
      mediator: {
        async requestSecretPrompt() {
          return { answered: false, abort: "peer_unconfirmed" };
        },
      },
    });
    await connectWithResponder(server.port, responder).then(
      () => undefined,
      () => undefined,
    );
    assert.deepEqual(server.state.receivedResponses, [[]]);
    const refusal = responder.takeLastRefusal();
    assert.equal(refusal?.reason, "passphrase_prompt");
    assert.equal(refusal?.mediatorAbort, "peer_unconfirmed");
  } finally {
    await server.close();
  }
});

test("prompt classification heuristics cover multilingual password semantics conservatively", () => {
  const classify = (prompt, echo = false) =>
    classifyKeyboardInteractivePrompt({ prompt, echo });
  // 密码白名单（多语言）
  for (const text of [
    "Password:",
    "alice@host's password: ",
    "Passwort:",
    "Mot de passe :",
    "Contraseña:",
    "Senha:",
    "Wachtwoord:",
    "Lösenord:",
    "Hasło:",
    "Пароль:",
    "كلمة المرور:",
    "密码：",
    "密碼：",
    "パスワードを入力してください",
    "비밀번호:",
    "Mật khẩu:",
    "Kata sandi:",
  ]) {
    assert.equal(classify(text), "password", `expected password semantics: ${text}`);
  }
  // 双因素标记优先于密码白名单（宁保守）
  assert.equal(classify("动态密码"), "second_factor");
  assert.equal(classify("Password (2FA):"), "second_factor");
  assert.equal(classify("Enter verification code:"), "second_factor");
  assert.equal(classify("Token:"), "second_factor");
  assert.equal(classify("PIN:"), "second_factor");
  assert.equal(classify("验证码"), "second_factor");
  assert.equal(classify("認証コード"), "second_factor");
  // 私钥口令 ≠ 连接密码
  assert.equal(classify("Enter passphrase for key 'id_rsa': "), "passphrase");
  assert.equal(classify("请输入私钥口令"), "passphrase");
  assert.equal(classify("Private key passphrase:"), "passphrase");
  // 可见输入槽位与未知语义一律不识别为密码
  assert.equal(classify("Username:", true), "unrecognized");
  assert.equal(classify("Password:", true), "unrecognized");
  assert.equal(classify("Continue?"), "unrecognized");
  assert.equal(classify(""), "unrecognized");
  // 消毒在分类前执行：零宽字符不能把 2FA 提示伪装成密码提示
  assert.equal(classify("Pass\u200Bword OTP code:"), "second_factor");
});
