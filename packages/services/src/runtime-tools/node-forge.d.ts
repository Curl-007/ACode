// node-forge 1.4.0 没有自带类型，也未安装 @types/node-forge。
// 这里只声明 appCaCert.ts 用到的最小 pki/md 子集，避免引入额外依赖。
//
// 本文件是 node-forge 环境声明的唯一事实源：cli 包（apps/acode-cli/packages/cli）
// 的 tsc 直接跟随 workspace 源码 import 拉入 appCaCert.ts，但环境声明不随 import
// 传播，故 cli 的 tsconfig 通过 files 显式引用本文件，不再保存第二份副本。
// 升级 node-forge 或安装 @types/node-forge 时只需删除本文件并同步移除 cli
// tsconfig 的 files 引用（tests/acp-host-adapter.test.mjs 的 F8 守护此约定）。
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
