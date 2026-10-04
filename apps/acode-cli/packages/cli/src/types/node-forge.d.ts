// node-forge 1.4.0 没有自带类型，也未安装 @types/node-forge。
// cli 包（apps/acode-cli）的 tsc 直接跟随 workspace 源码 import（无工程引用），
// 看不到 services 包内的同名环境声明；`acode acp` 经 @acode/server →
// @acode/services 把 appCaCert.ts 拉进本程序后需要这里的声明兜底。
// 内容与 packages/services/src/runtime-tools/node-forge.d.ts 逐字一致
// （最小 pki/md 子集）；升级 node-forge 或安装 @types 时两处同步删除。
declare module "node-forge" {
  interface ForgeKey {
    n?: unknown;
  }
  interface ForgeKeyPair {
    publicKey: ForgeKey;
    privateKey: ForgeKey;
  }
  interface ForgeCertAttr {
    name?: string;
    shortName?: string;
    type?: string;
    value?: string;
  }
  interface ForgeCertExtension {
    name: string;
    cA?: boolean;
    critical?: boolean;
    keyCertSign?: boolean;
    cRLSign?: boolean;
    digitalSignature?: boolean;
    keyEncipherment?: boolean;
    serverAuth?: boolean;
    clientAuth?: boolean;
  }
  interface ForgeMessageDigest {
    update(msg: string): ForgeMessageDigest;
  }
  interface ForgeCertificate {
    publicKey: ForgeKey;
    serialNumber: string;
    validity: { notBefore: Date; notAfter: Date };
    setSubject(attrs: ForgeCertAttr[]): void;
    setIssuer(attrs: ForgeCertAttr[]): void;
    setExtensions(exts: ForgeCertExtension[]): void;
    sign(key: ForgeKey, md?: ForgeMessageDigest): void;
  }
  interface ForgeStatic {
    pki: {
      rsa: { generateKeyPair(bits: number): ForgeKeyPair };
      createCertificate(): ForgeCertificate;
      certificateToPem(cert: ForgeCertificate): string;
      privateKeyToPem(key: ForgeKey): string;
    };
    md: { sha256: { create(): ForgeMessageDigest } };
  }
  const forge: ForgeStatic;
  export = forge;
}
