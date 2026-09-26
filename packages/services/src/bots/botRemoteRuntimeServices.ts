import {
  ChannelClient,
  MessagePortProtocol,
  ProxyChannel,
  type MessagePortLike,
  type MessagePortPayload,
} from "@acode/rpc";
import {
  IACodeTaskService,
  type IACodeTaskService as IACodeTaskServiceShape,
} from "#src/session/acodeTaskService.js";
import {
  IACodeAgentService,
  type IACodeAgentService as IACodeAgentServiceShape,
} from "#src/acode-agent/acodeAgent.js";
import {
  IACodeSessionService,
  type IACodeSessionService as IACodeSessionServiceShape,
} from "#src/acode-session/acodeSession.js";
import {
  IModelSelectionService,
  type IModelSelectionService as IModelSelectionServiceShape,
} from "#src/model-provider/providerFacadeServices.js";

interface PortLike {
  on?(event: "message", listener: (event: { data: MessagePortPayload }) => void): void;
  off?(event: "message", listener: (event: { data: MessagePortPayload }) => void): void;
  addEventListener?(
    event: "message",
    listener: (event: { data: MessagePortPayload }) => void,
  ): void;
  removeEventListener?(
    event: "message",
    listener: (event: { data: MessagePortPayload }) => void,
  ): void;
  postMessage(message: MessagePortPayload): void;
  start?(): void;
  close?(): void;
}

function toMessagePortLike(port: PortLike): MessagePortLike {
  return {
    addEventListener(type, listener) {
      if (port.addEventListener) {
        port.addEventListener(type, listener);
        return;
      }
      port.on?.(type, listener);
    },
    removeEventListener(type, listener) {
      if (port.removeEventListener) {
        port.removeEventListener(type, listener);
        return;
      }
      port.off?.(type, listener);
    },
    postMessage(data) {
      port.postMessage(data);
    },
    start() {
      port.start?.();
    },
    close() {
      port.close?.();
    },
  };
}

export interface RemoteBotWorkspaceRuntimeServices {
  acodeAgentService: IACodeAgentServiceShape;
  acodeTaskService: IACodeTaskServiceShape;
  acodeSessionService: IACodeSessionServiceShape;
  modelSelectionService: IModelSelectionServiceShape;
}

export function createRemoteRuntimeServicesFromPort(
  port: unknown,
): RemoteBotWorkspaceRuntimeServices {
  const protocol = new MessagePortProtocol(toMessagePortLike(port as PortLike));
  const client = new ChannelClient(protocol);
  return {
    acodeAgentService: ProxyChannel.toService<IACodeAgentServiceShape>(
      client.getChannel(IACodeAgentService.channelName),
    ),
    acodeTaskService: ProxyChannel.toService<IACodeTaskServiceShape>(
      client.getChannel(IACodeTaskService.channelName),
    ),
    acodeSessionService: ProxyChannel.toService<IACodeSessionServiceShape>(
      client.getChannel(IACodeSessionService.channelName),
    ),
    modelSelectionService: ProxyChannel.toService<IModelSelectionServiceShape>(
      client.getChannel(IModelSelectionService.channelName),
    ),
  };
}
