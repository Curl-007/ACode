import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelClient, ChannelServer, createQueuePair, type IChannel } from "@acode/rpc";
import {
  ServiceCollection,
  type ServiceDescriptor,
  IFileService,
  IOAuthService,
} from "../src/index.js";

/**
 * ARCH-01 迁移验收：补齐 file / oauth 已登记 argumentValidators 缺失的非法参数行为测试。
 * 经真实 ProxyChannel.fromService + ChannelClient/ChannelServer 往返，验证：
 *  - code "rpc-invalid-arguments"、正确 method、value-free details；
 *  - 服务方法体在校验失败时不执行；
 *  - 合法调用放行；oauth 无参读方法拒绝多余实参。
 */

interface RpcErrorShape {
  code?: string;
  method?: string;
  details?: string;
  message?: string;
}

function assertRpcArgumentError(
  error: unknown,
  method: string,
  forbidden: readonly string[],
): void {
  const err = error as RpcErrorShape;
  assert.equal(err.code, "rpc-invalid-arguments", `code for ${method}`);
  assert.equal(err.method, method, `method for ${method}`);
  const details = String(err.details ?? "");
  const message = String(err.message ?? "");
  assert.ok(details.length > 0, `details present for ${method}`);
  for (const token of forbidden) {
    assert.equal(details.includes(token), false, `details leaked ${token} for ${method}`);
    assert.equal(message.includes(token), false, `message leaked ${token} for ${method}`);
  }
}

async function withWire<T>(
  descriptor: ServiceDescriptor<T>,
  stub: object,
  run: (channel: IChannel) => Promise<void>,
): Promise<void> {
  const [clientProtocol, serverProtocol] = createQueuePair();
  const server = new ChannelServer(serverProtocol, "file-oauth-validators");
  const client = new ChannelClient(clientProtocol);
  new ServiceCollection().register(descriptor, stub as unknown as T).exposeOnChannelServer(server);
  try {
    await run(client.getChannel(descriptor.channelName));
  } finally {
    client.dispose();
    server.dispose();
  }
}

// ---------------------------------------------------------------------------
// IFileService —— readTextFile / writeWorkspaceFileSearchIgnore / readFileRange / checkFilesExist
// ---------------------------------------------------------------------------

test("file: readTextFile 非字符串/缺失 path 在方法体前拒绝", async () => {
  const calls: string[] = [];
  const stub = {
    readTextFile: async () => {
      calls.push("readTextFile");
      return {};
    },
  };
  await withWire(IFileService, stub, async (channel) => {
    // path 非字符串（对象），且带敏感标记
    await assert.rejects(
      channel.call("readTextFile", [{ path: { secret: "LEAK_PATH" } }]),
      (error) => {
        assertRpcArgumentError(error, "readTextFile", ["LEAK_PATH"]);
        return true;
      },
    );
    // 缺失 path
    await assert.rejects(channel.call("readTextFile", [{}]), (error) => {
      assertRpcArgumentError(error, "readTextFile", []);
      return true;
    });
    // 完全缺失参数对象
    await assert.rejects(channel.call("readTextFile", []), (error) => {
      assertRpcArgumentError(error, "readTextFile", []);
      return true;
    });
    assert.deepEqual(calls, [], "方法体不得执行");
    await channel.call("readTextFile", [{ path: "/some/file.txt" }]);
    assert.deepEqual(calls, ["readTextFile"]);
  });
});

test("file: writeWorkspaceFileSearchIgnore 非法 shape 拒绝，合法放行", async () => {
  const calls: string[] = [];
  const stub = {
    writeWorkspaceFileSearchIgnore: async () => {
      calls.push("writeWorkspaceFileSearchIgnore");
    },
  };
  await withWire(IFileService, stub, async (channel) => {
    // content 非字符串
    await assert.rejects(
      channel.call("writeWorkspaceFileSearchIgnore", [
        { rootPath: "/w", content: { leak: "SECRET_CONTENT" } },
      ]),
      (error) => {
        assertRpcArgumentError(error, "writeWorkspaceFileSearchIgnore", ["SECRET_CONTENT"]);
        return true;
      },
    );
    // 缺失 content
    await assert.rejects(
      channel.call("writeWorkspaceFileSearchIgnore", [{ rootPath: "/w" }]),
      (error) => {
        assertRpcArgumentError(error, "writeWorkspaceFileSearchIgnore", []);
        return true;
      },
    );
    assert.deepEqual(calls, [], "方法体不得执行");
    await channel.call("writeWorkspaceFileSearchIgnore", [{ rootPath: "/w", content: "ignore" }]);
    assert.deepEqual(calls, ["writeWorkspaceFileSearchIgnore"]);
  });
});

test("file: readFileRange 负 offset 拒绝，checkFilesExist 非数组 paths 拒绝", async () => {
  const calls: string[] = [];
  const stub = {
    readFileRange: async () => {
      calls.push("readFileRange");
      return new Uint8Array();
    },
    checkFilesExist: async () => {
      calls.push("checkFilesExist");
      return [];
    },
  };
  await withWire(IFileService, stub, async (channel) => {
    await assert.rejects(
      channel.call("readFileRange", [{ path: "/f", offset: -1, length: 10 }]),
      (error) => {
        assertRpcArgumentError(error, "readFileRange", []);
        return true;
      },
    );
    await assert.rejects(channel.call("checkFilesExist", [{ paths: "SECRET_PATHS" }]), (error) => {
      assertRpcArgumentError(error, "checkFilesExist", ["SECRET_PATHS"]);
      return true;
    });
    assert.deepEqual(calls, [], "方法体不得执行");
    await channel.call("readFileRange", [{ path: "/f", offset: 0, length: 10 }]);
    await channel.call("checkFilesExist", [{ paths: ["/a", "/b"] }]);
    assert.deepEqual(calls, ["readFileRange", "checkFilesExist"]);
  });
});

// ---------------------------------------------------------------------------
// IOAuthService —— handleCallback / startOAuth 非法参数 + 无参读方法拒绝多余实参
// ---------------------------------------------------------------------------

test("oauth: handleCallback/startOAuth 非法参数在方法体前拒绝", async () => {
  const calls: string[] = [];
  const stub = {
    handleCallback: async () => {
      calls.push("handleCallback");
      return null;
    },
    startOAuth: async () => {
      calls.push("startOAuth");
      return {};
    },
  };
  await withWire(IOAuthService, stub, async (channel) => {
    // handleCallback 非字符串
    await assert.rejects(channel.call("handleCallback", [{ url: "SECRET_URL" }]), (error) => {
      assertRpcArgumentError(error, "handleCallback", ["SECRET_URL"]);
      return true;
    });
    // handleCallback 缺失参数
    await assert.rejects(channel.call("handleCallback", []), (error) => {
      assertRpcArgumentError(error, "handleCallback", []);
      return true;
    });
    // startOAuth 空字符串 provider
    await assert.rejects(channel.call("startOAuth", [""]), (error) => {
      assertRpcArgumentError(error, "startOAuth", []);
      return true;
    });
    // startOAuth 非字符串
    await assert.rejects(channel.call("startOAuth", [{ provider: "SECRET_PROV" }]), (error) => {
      assertRpcArgumentError(error, "startOAuth", ["SECRET_PROV"]);
      return true;
    });
    assert.deepEqual(calls, [], "方法体不得执行");
    await channel.call("handleCallback", ["https://callback.example/cb"]);
    await channel.call("startOAuth", ["bigmodel"]);
    assert.deepEqual(calls, ["handleCallback", "startOAuth"]);
  });
});

test("oauth: 无参读方法拒绝多余实参，缺省调用放行", async () => {
  const calls: string[] = [];
  const stub = {
    getProviders: async () => {
      calls.push("getProviders");
      return [];
    },
    restoreSession: async () => {
      calls.push("restoreSession");
      return null;
    },
    logoutAll: async () => {
      calls.push("logoutAll");
    },
  };
  await withWire(IOAuthService, stub, async (channel) => {
    await assert.rejects(channel.call("getProviders", ["LEAK-extra"]), (error) => {
      assertRpcArgumentError(error, "getProviders", ["LEAK-extra"]);
      return true;
    });
    await assert.rejects(channel.call("restoreSession", [{ token: "SECRET_TOKEN" }]), (error) => {
      assertRpcArgumentError(error, "restoreSession", ["SECRET_TOKEN"]);
      return true;
    });
    await assert.rejects(channel.call("logoutAll", ["anything"]), (error) => {
      assertRpcArgumentError(error, "logoutAll", ["anything"]);
      return true;
    });
    assert.deepEqual(calls, [], "方法体不得执行");
    await channel.call("getProviders", []);
    await channel.call("restoreSession", []);
    await channel.call("logoutAll", []);
    assert.deepEqual(calls, ["getProviders", "restoreSession", "logoutAll"]);
  });
});
