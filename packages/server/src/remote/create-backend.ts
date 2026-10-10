import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { RemoteTarget } from "@acode/shared";
import type { IRemoteBackend } from "./backend.js";

import type { SSHHostKeyChallengeHandler, SSHHostKeyTrust } from "./sshAuth.js";
import { createKnownHostsTrust } from "./sshKnownHosts.js";

export interface RemoteBackendOptions {
  /** SSH host key trust is owned by the host/desktop layer and read-only here. */
  sshHostKeyTrust?: SSHHostKeyTrust;
  onHostKeyChallenge?: SSHHostKeyChallengeHandler;
}

export async function createRemoteBackend(
  target: RemoteTarget,
  options?: RemoteBackendOptions,
): Promise<IRemoteBackend> {
  switch (target.kind) {
    case "ssh": {
      const { SSHBackend } = await import("./ssh-backend.js");
      let privateKey: string | Buffer | undefined;
      if (target.privateKeyPath) {
        const keyPath = target.privateKeyPath.replace(/^~/, homedir());
        privateKey = await readFile(keyPath);
      }

      return new SSHBackend({
        host: target.host,
        port: target.port,
        username: target.username,
        password: target.password,
        privateKeyPath: target.privateKeyPath,
        privateKeyPassphrase: target.privateKeyPassphrase,
        privateKey,
        // Host/CLI 可显式注入受管信任；默认只读本机 known_hosts，缺失时继续 fail-closed。
        hostKeyTrust: options?.sshHostKeyTrust ?? (await createKnownHostsTrust()),
        onHostKeyChallenge: options?.onHostKeyChallenge,
      });
    }
    case "wsl": {
      const { WSLBackend } = await import("./wsl-backend.js");
      return new WSLBackend(target);
    }
    case "docker": {
      const { DockerBackend } = await import("./docker-backend.js");
      return new DockerBackend(target);
    }
    case "server":
      // server kind 附着到已运行的 server（WebSocket RPC），没有 stdio backend，
      // 也不部署/拉起远端进程。误入 deploy 路径时显式拒绝，避免半连接。
      throw new Error(
        "server 远端类型通过 WebSocket 附着已运行的 server，不能经 createRemoteBackend 创建 stdio backend",
      );
  }
}
