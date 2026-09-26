import { useACodeStoreWithDefault } from "@/store/StoreProvider.js";

export function useIsOfficeMode(): boolean {
  return useACodeStoreWithDefault((state) => state.interfaceMode === "office", false);
}
