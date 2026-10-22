import assert from "node:assert/strict";
import test from "node:test";
import type { NewTaskDefaults } from "@acode/shared";
import {
  initializeNewTaskDraft,
  refreshUneditedNewTaskDefaults,
} from "../src/v4/composer/newTaskDraft.js";
import type { V4ComposerDraft } from "../src/v4/composer/composerDraftStore.js";

function view(preferredSelection?: { providerId: string; modelId: string }) {
  return {
    revision: 1,
    preferredSelection,
    providers: [
      {
        providerId: "custom",
        providerName: "Custom",
        models: [
          {
            modelId: "demo",
            config: { optionSpecs: { reasoningLevel: { values: ["low", "medium", "max"] } } },
          },
        ],
      },
    ],
  } as unknown as Parameters<typeof initializeNewTaskDraft>[3];
}

function defaults(overrides: Partial<NewTaskDefaults> = {}): NewTaskDefaults {
  return {
    enabled: true,
    mode: "yolo",
    model: { providerId: "custom", modelId: "demo" },
    reasoningLevel: "medium",
    ...overrides,
  };
}

const emptyDraft: V4ComposerDraft = { text: "", updatedAt: 0 };

test("初始化新任务草稿时应用固定的权限模式、模型与推理强度", () => {
  const draft = initializeNewTaskDraft(
    emptyDraft,
    "/workspace",
    undefined,
    view(),
    defaults(),
    "first",
  );
  assert.equal(draft.mode, "yolo");
  assert.deepEqual(draft.modelSelection, {
    providerId: "custom",
    modelId: "demo",
    options: { reasoningLevel: "medium" },
  });
  assert.equal(draft.planEnabled, false);
});

test("固定模型已移除时回落到首选模型，固定档位仍按目标模型校验", () => {
  const draft = initializeNewTaskDraft(
    emptyDraft,
    "/workspace",
    undefined,
    view({ providerId: "custom", modelId: "demo" }),
    defaults({ model: { providerId: "gone", modelId: "missing" }, reasoningLevel: "max" }),
  );
  assert.deepEqual(draft.modelSelection, {
    providerId: "custom",
    modelId: "demo",
    options: { reasoningLevel: "max" },
  });
});

test("目录刷新重新推导默认档时不会覆盖固定档位", () => {
  const draft: V4ComposerDraft = {
    text: "",
    mode: "build",
    modelSelection: {
      providerId: "custom",
      modelId: "demo",
      options: { reasoningLevel: "low" },
    },
    updatedAt: 1,
  };
  assert.deepEqual(
    refreshUneditedNewTaskDefaults(draft, view(), defaults(), "highest").modelSelection,
    {
      providerId: "custom",
      modelId: "demo",
      options: { reasoningLevel: "medium" },
    },
  );
});

test("用户已改选或正文非空时目录刷新不覆盖草稿", () => {
  const edited: V4ComposerDraft = {
    text: "",
    mode: "build",
    modelSelectionEdited: true,
    modelSelection: {
      providerId: "custom",
      modelId: "demo",
      options: { reasoningLevel: "low" },
    },
    updatedAt: 1,
  };
  assert.equal(refreshUneditedNewTaskDefaults(edited, view(), defaults()), edited);
  const withText: V4ComposerDraft = {
    text: "hello",
    mode: "build",
    updatedAt: 1,
  };
  assert.equal(refreshUneditedNewTaskDefaults(withText, view(), defaults()), withText);
});

test("解析结果与既有草稿一致时返回原对象", () => {
  const draft: V4ComposerDraft = {
    text: "",
    mode: "build",
    modelSelection: {
      providerId: "custom",
      modelId: "demo",
      options: { reasoningLevel: "medium" },
    },
    updatedAt: 1,
  };
  assert.equal(refreshUneditedNewTaskDefaults(draft, view(), defaults()), draft);
});
