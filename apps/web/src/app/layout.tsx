import type { Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";
import { Geist, Martian_Mono } from "next/font/google";
import { cn } from "@/lib/utils";

// 两个家族各司其职（DESIGN.md 第 3 节）：Geist 承载正文与表单，
// Martian Mono 承载标题、标签与数据。CJK fallback 挂在 globals.css 的字体栈里。
const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const martianMono = Martian_Mono({ subsets: ["latin"], variable: "--font-martian-mono" });

export const metadata = {
  title: "Agent Coordinator",
  description: "Agent coordination console",
};

// 与 globals.css 的 --background 对应：深色 oklch(0.15 0.006 200)、浅色 oklch(0.97 0.004 200)
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f6f6" },
    { media: "(prefers-color-scheme: dark)", color: "#080c0c" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" className={cn("font-sans", geist.variable, martianMono.variable)}>
      <body>{children}</body>
    </html>
  );
}
