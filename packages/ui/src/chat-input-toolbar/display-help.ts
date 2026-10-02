import type { ACodeProvider } from "@acode/shared";

// 引擎联合只剩 native(glm)（外部引擎槽位已下线）；保留 Partial 形状，
// 未来新增引擎无需在此登记即可编译。
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
