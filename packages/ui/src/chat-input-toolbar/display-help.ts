import type { ACodeProvider } from "@acode/shared";

// provider 已拓宽为引擎联合（native + codex/opencode/gemini）；mode 文案目前只覆盖 native(glm)。
// 用 Partial 让外部引擎缺省回退到调用方的 ?? null，新增引擎无需在此登记即可编译。
export const ACODE_MODE_OPTION_LABEL_IDS: Partial<Record<ACodeProvider, Record<string, string>>> = {
  glm: {
    build: "mode.label.glm.build",
    edit: "mode.label.glm.edit",
    plan: "mode.label.glm.plan",
    yolo: "mode.label.glm.yolo",
  },
};

export const ACODE_MODE_OPTION_DESCRIPTION_IDS: Partial<
  Record<ACodeProvider, Record<string, string>>
> = {
  glm: {
    build: "mode.description.glm.build",
    edit: "mode.description.glm.edit",
    plan: "mode.description.glm.plan",
    yolo: "mode.description.glm.yolo",
  },
};
