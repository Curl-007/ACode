import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";

interface RootStartupLoadingProps {
  label: string;
  children?: ReactNode;
  busy?: boolean;
}

export function RootStartupLoading({ label, children, busy = true }: RootStartupLoadingProps) {
  return (
    <div
      // Web 端全局 html/body/#root 为 Electron 透明背景让路，React 接管后会替换 HTML 启动壳。
      // 这里必须由阻塞态自身承接主题背景，否则远控链接会在 Root 恢复期间继续露出浏览器白底。
      className="flex h-full min-h-dvh flex-col items-center justify-center gap-6 bg-background text-foreground"
      role="status"
      aria-busy={busy}
      aria-label={label}
      data-testid="root-startup-loading"
    >
      <ACodeStartupLogoBadge />
      {children}
    </div>
  );
}

/** 初始化与引导共用品牌图标，保持底色、描边、圆角和标志比例一致。 */
export function ACodeStartupLogoBadge({ animated = true }: { animated?: boolean }) {
  return (
    <div className="relative flex size-24 items-center justify-center rounded-3xl bg-[linear-gradient(180deg,#000000_0%,#151718_100%)] text-[#ffffff] shadow-xl/20 before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:border before:border-[rgba(255,255,255,0.1)] before:content-['']">
      <ACodeStartupLogo className="h-auto w-14" animated={animated} />
    </div>
  );
}

function ACodeStartupLogo({
  className,
  animated = true,
}: {
  className?: string;
  animated?: boolean;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="158"
      height="100"
      fill="none"
      viewBox="120 264 784 496"
      className={cn("shrink-0 text-current", className)}
      aria-hidden="true"
      focusable="false"
    >
      {animated ? (
        <animate
          attributeName="opacity"
          begin="3s"
          dur="1.8s"
          repeatCount="indefinite"
          values="1;0.4;1"
        />
      ) : null}
      {/* 品牌括号与 AI 星光使用图标同款对角渐变，避免在深色启动底上呈现为纯白。 */}
      <defs>
        <linearGradient
          id="acode-brand-gradient"
          x1="760"
          y1="300"
          x2="300"
          y2="720"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#38bdf8" />
          <stop offset="1" stopColor="#818cf8" />
        </linearGradient>
      </defs>
      <path
        d="M368 312L168 512L368 712"
        fill="none"
        stroke="#38bdf8"
        strokeWidth="96"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        fill="url(#acode-brand-gradient)"
        d="M512 380C525 462 562 499 644 512C562 525 525 562 512 644C499 562 462 525 380 512C462 499 499 462 512 380Z"
      />
      <path
        d="M656 312L856 512L656 712"
        fill="none"
        stroke="#818cf8"
        strokeWidth="96"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
