export interface HelloMessage {
  type: "acode-hello";
  version: string;
  platform: string;
  arch: string;
  pid: number;
}

export interface HelloAckMessage {
  type: "acode-hello-ack";
  version: string;
  clientId: string;
}
