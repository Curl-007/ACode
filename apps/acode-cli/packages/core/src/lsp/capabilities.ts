// Ported from oh-my-pi (MIT) — packages/coding-agent/src/lsp/client.ts（CLIENT_CAPABILITIES 切片）, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// LSP initialize 握手声明的客户端能力
// ============================================================

const SYMBOL_KIND_VALUE_SET = Array.from({ length: 26 }, (_, index) => index + 1);

export const CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: { didSave: true, dynamicRegistration: false, willSave: false, willSaveWaitUntil: false },
    hover: { contentFormat: ["markdown", "plaintext"], dynamicRegistration: false },
    definition: { dynamicRegistration: false, linkSupport: true },
    typeDefinition: { dynamicRegistration: false, linkSupport: true },
    implementation: { dynamicRegistration: false, linkSupport: true },
    references: { dynamicRegistration: false },
    documentSymbol: {
      dynamicRegistration: false,
      hierarchicalDocumentSymbolSupport: true,
      symbolKind: { valueSet: SYMBOL_KIND_VALUE_SET },
    },
    rename: { dynamicRegistration: false, prepareSupport: true },
    codeAction: {
      dynamicRegistration: false,
      codeActionLiteralSupport: {
        codeActionKind: {
          valueSet: [
            "quickfix",
            "refactor",
            "refactor.extract",
            "refactor.inline",
            "refactor.rewrite",
            "source",
            "source.organizeImports",
            "source.fixAll",
          ],
        },
      },
      resolveSupport: { properties: ["edit"] },
    },
    formatting: { dynamicRegistration: false },
    rangeFormatting: { dynamicRegistration: false },
    publishDiagnostics: {
      relatedInformation: true,
      versionSupport: true,
      tagSupport: { valueSet: [1, 2] },
      codeDescriptionSupport: true,
      dataSupport: true,
    },
  },
  window: { workDoneProgress: true },
  workspace: {
    applyEdit: true,
    workspaceEdit: {
      documentChanges: true,
      resourceOperations: ["create", "rename", "delete"],
      failureHandling: "abort",
    },
    configuration: true,
    workspaceFolders: true,
    symbol: { dynamicRegistration: false, symbolKind: { valueSet: SYMBOL_KIND_VALUE_SET } },
    fileOperations: {
      dynamicRegistration: false,
      willCreate: false,
      didCreate: false,
      willRename: true,
      didRename: true,
      willDelete: false,
      didDelete: false,
    },
  },
} as const;
