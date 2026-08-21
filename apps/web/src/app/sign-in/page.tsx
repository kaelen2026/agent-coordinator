import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AuthPageShell } from "@/components/auth/auth-page-shell";
import { SignInPanel } from "@/components/auth/sign-in-panel";
import { Spinner } from "@/components/ui/spinner";

export const metadata: Metadata = {
  title: "登录 · Agent Coordinator",
  description: "用邮箱和密码登录 Agent Coordinator。",
};

export default function SignInPage() {
  return (
    <AuthPageShell
      title="登录"
      description="用邮箱和密码继续。"
      footer={
        <>
          还没有账号？
          <Link className="text-primary underline underline-offset-4" href="/sign-up">
            注册一个
          </Link>
        </>
      }
    >
      {/* useSearchParams 需要 Suspense 边界，否则整页被迫退化为动态渲染 */}
      <Suspense fallback={<Spinner aria-label="加载中" />}>
        <SignInPanel />
      </Suspense>
    </AuthPageShell>
  );
}
