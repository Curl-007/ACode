import { create } from "zustand";

/**
 * 嵌入式浏览器站点权限的未决弹窗（packages/desktop/specs/embedded-browser-site-permissions.md
 * 的 renderer 侧状态）。形状仿 `alertDialogStore.ts`：弹窗是 renderer 的**展示**状态，数据
 * 来自 main 推送（preload 的 `onEmbeddedBrowserPermissionPrompt`），应答经
 * `resolveEmbeddedBrowserPermission` 回 main——本 store 只排队，不碰 IPC。
 *
 * 与 alertDialog 的差异：权限请求按 requestId **排队**而不是单发替换——main 对同一
 * (origin, permission) 去重，但不同权限可以同时在等；替换式弹窗会静默丢掉一个未决请求，
 * 那个请求在 main 里就永远悬着。队列有上界（8，与 workflow 投影的 pendingHoles 同档），
 * 超界挤掉最旧的一条并把它交还给调用方按 deny-once 结算（弹窗窗口过载时宁可拒绝也不悬置）。
 */
export interface EmbeddedBrowserPermissionPrompt {
  requestId: string;
  origin: string;
  permission: string;
  /** `media` 请求的细分（camera/microphone）；其余权限缺席。 */
  mediaTypes?: string[];
}

/** 同队上限：同一窗口同时悬着的权限弹窗超过它就挤最旧的（deny-once 兜底）。 */
const MAX_PENDING_PROMPTS = 8;

interface EmbeddedBrowserPermissionPromptState {
  prompts: EmbeddedBrowserPermissionPrompt[];
  /**
   * main 推来一条未决请求。返回被挤掉的旧请求（调用方必须对它回 deny-once），
   * 没有挤掉则返回 undefined。
   */
  pushPrompt: (payload: EmbeddedBrowserPermissionPrompt) => EmbeddedBrowserPermissionPrompt | undefined;
  /** 应答已发出（或请求被撤下）：按 requestId 出队。 */
  settlePrompt: (requestId: string) => void;
}

export const useEmbeddedBrowserPermissionPromptStore =
  create<EmbeddedBrowserPermissionPromptState>((set) => ({
    prompts: [],
    pushPrompt: (payload) => {
      let evicted: EmbeddedBrowserPermissionPrompt | undefined;
      set((state) => {
        // 同 requestId 重复推送按幂等处理：只保留最早那条（main 侧已去重，这是防御）。
        if (state.prompts.some((prompt) => prompt.requestId === payload.requestId)) {
          return state;
        }
        const next = [...state.prompts, payload];
        if (next.length > MAX_PENDING_PROMPTS) {
          evicted = next.shift();
        }
        return { prompts: next };
      });
      return evicted;
    },
    settlePrompt: (requestId) => {
      set((state) => ({
        prompts: state.prompts.filter((prompt) => prompt.requestId !== requestId),
      }));
    },
  }));
