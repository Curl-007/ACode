import { applyPersistedAppearancePreferences } from "@/lib/appearancePreferences.js";

export type Theme = "light" | "dark" | "zai-light" | "zai-dark" | "system";
export type ResolvedTheme = "light" | "dark";

const BROWSER_THEME_SURFACE_ATTRIBUTE = "data-acode-browser-theme-surface";

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === "system") {
    return getSystemTheme();
  }

  return theme === "dark" || theme === "zai-dark" ? "dark" : "light";
}

export function normalizeThemePreference(theme: Theme): Theme {
  if (theme === "dark") return "zai-dark";
  if (theme === "light") return "zai-light";
  return theme;
}

function setThemeMetaContent(name: "theme-color" | "color-scheme", content: string) {
  let meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = name;
    document.head.append(meta);
  }
  meta.content = content;
}

function syncBrowserThemeSurface(resolved: ResolvedTheme) {
  const root = document.documentElement;
  if (
    typeof root.hasAttribute !== "function" ||
    !root.hasAttribute(BROWSER_THEME_SURFACE_ATTRIBUTE)
  ) {
    return;
  }

  // Electron 为 vibrancy 保持透明根背景，但普通浏览器需要从文档根和标准 meta
  // 获得页面主题。只切换 React 的 dark class 会让浏览器工具栏、原生控件和 overscroll 留在旧主题。
  root.setAttribute(BROWSER_THEME_SURFACE_ATTRIBUTE, resolved);
  root.style.colorScheme = resolved;
  setThemeMetaContent("color-scheme", resolved);

  const background = getComputedStyle(root).getPropertyValue("--color-background").trim();
  if (background) {
    setThemeMetaContent("theme-color", background);
  }
}

export function applyTheme(theme: Theme) {
  const resolved = resolveTheme(theme);
  const appliedTheme =
    theme === "system"
      ? resolved === "dark"
        ? "zai-dark"
        : "zai-light"
      : normalizeThemePreference(theme);
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.classList.toggle("theme-zai-light", appliedTheme === "zai-light");
  document.documentElement.classList.toggle("theme-zai-dark", appliedTheme === "zai-dark");
  syncBrowserThemeSurface(resolved);
  // 多轴外观偏好属性在主题应用点收口（specs/appearance-preference-axes.md R6）：
  // applyTheme 是主窗口 store 创建、setTheme（含广播）与 system 主题变化的公共路径
  // （R2-07 后 useTheme hook 已删除，不再作为调用方），对齐 syncBrowserThemeSurface 的
  // 「根属性随主题应用一并写」模式，各窗口零新增接线即获得 data-acode-density/-text-size/
  // -reduce-motion 属性面。setAttribute 幂等，主题反复切换不产生重算成本；偏好自身的写入口在
  // lib/appearancePreferences.ts（设置页接线后直接调它，不经主题绕路）。
  applyPersistedAppearancePreferences();
}

// R2-07: useTheme() hook 本体已删除。它自带 useState + 直接写 localStorage 的 acode-theme 键，
// 绕过 store/index.ts 的 setTheme（唯一走广播防回环、system 监听与 applyPersistedAppearancePreferences
// 收口的写入口），全仓无实际调用点（仅 index.ts 曾导出）。原私有 isTheme 校验函数随之删除：
// store/index.ts 读取该键时用 normalizeThemePreference + 默认 zai-dark 兜底，不依赖该守卫。
