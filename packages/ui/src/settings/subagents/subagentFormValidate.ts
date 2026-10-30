/**
 * 子智能体表单提交前的字段校验纯函数（split-plan settings/SubagentsSection.tsx 批次 2
 * 辅助拆分）。
 *
 * `SubagentForm.tsx` 421 物理行超 oxlint max-lines 400 上限（split-plan 「新模块
 * <400 行」），把 `validate` 函数（行 228–287，60 行）抽为纯函数，主文件回落至
 * <400。本函数不消费 React hooks / store，错误词条 key 经入参 intl 适配器传回——
 * 保持「i18n 文案由 SubagentForm 主组件集中管理」的边界。
 *
 * 行为不变量（被 SubagentForm 的 handleSubmit 调用，间接由 test/subagentSections.test.ts
 * 结构守护断言锚定）：
 *  - 名称 3–50 字符 + `[a-zA-Z0-9-]+` 字符集；
 *  - description / systemPrompt 必填；
 *  - 失效模型/不可用档位/不可用速度 阻止保存；
 *  - 各项校验互不短路：即便前项已失败，仍把后续字段的 error state 一并更新
 *    （让用户一次看到全部问题，避免「修了名称再发现 description 也没填」的来回）。
 */

/** 与 SubagentForm 的 intl.formatMessage 形状对齐的最小适配器。 */
export interface SubagentFormValidateIntl {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string;
}

/** 各字段错误词条的 set/clear 回调集合：每个回调接收 null 表示清空错误。 */
export interface SubagentFormValidateSetters {
  setNameError: (message: string | null) => void;
  setDescriptionError: (message: string | null) => void;
  setPromptError: (message: string | null) => void;
  setModelError: (message: string | null) => void;
}

export interface SubagentFormValidateInput {
  name: string;
  description: string;
  systemPrompt: string;
  /** 失效模型/不可用档位/不可用速度 由调用方预先计算（它们依赖 modelSelectionView 等 hooks 产物）。 */
  modelAvailable: boolean;
  thoughtLevelInvalid: boolean;
  speedInvalid: boolean;
}

/**
 * 校验并写入错误 state。返回 true 表示所有字段都通过，可以进入 onSave。
 * 副作用：调用 4 个 set*Error 写入对应字段的最新错误（或清空）。
 */
export function validateSubagentFormFields(
  input: SubagentFormValidateInput,
  setters: SubagentFormValidateSetters,
  intl: SubagentFormValidateIntl,
): boolean {
  const trimmedName = input.name.trim();
  let valid = true;
  if (trimmedName.length < 3 || trimmedName.length > 50) {
    setters.setNameError(
      intl.formatMessage(
        { id: "settings.subagents.form.validation.nameLength" },
        { min: "3", max: "50" },
      ),
    );
    valid = false;
  } else if (!/^[a-zA-Z0-9-]+$/u.test(trimmedName)) {
    setters.setNameError(
      intl.formatMessage({
        id: "settings.subagents.form.validation.nameCharacters",
      }),
    );
    valid = false;
  } else {
    setters.setNameError(null);
  }
  if (!input.description.trim()) {
    setters.setDescriptionError(
      intl.formatMessage({
        id: "settings.subagents.form.validation.descriptionRequired",
      }),
    );
    valid = false;
  } else {
    setters.setDescriptionError(null);
  }
  if (!input.systemPrompt.trim()) {
    setters.setPromptError(
      intl.formatMessage({
        id: "settings.subagents.form.validation.promptRequired",
      }),
    );
    valid = false;
  } else {
    setters.setPromptError(null);
  }
  // 不可用模型会展示为“选择模型”，保存时也必须阻止历史值被静默写回。
  if (!input.modelAvailable) {
    setters.setModelError(
      intl.formatMessage({
        id: "settings.subagents.form.validation.modelUnavailable",
      }),
    );
    valid = false;
  } else {
    setters.setModelError(null);
  }
  if (input.thoughtLevelInvalid) {
    valid = false;
  }
  if (input.speedInvalid) {
    valid = false;
  }
  return valid;
}
