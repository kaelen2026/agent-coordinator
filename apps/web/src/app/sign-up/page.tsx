import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AuthPageShell } from "@/components/auth/auth-page-shell";
import { SignUpPanel } from "@/components/auth/sign-up-panel";
import { Spinner } from "@/components/ui/spinner";

export const metadata: Metadata = {
  title: "注册 · Agent Coordinator",
  description: "用邮箱和密码注册 Agent Coordinator 账号。",
};

export default function SignUpPage() {
  return (
    <AuthPageShell
      title="注册"
      description="填写下面的信息创建账号，注册后会自动登录。"
      footer={
        <>
          已经有账号了？
          <Link className="text-primary underline underline-offset-4" href="/sign-in">
            去登录
          </Link>
        </>
      }
    >
      <Suspense fallback={<Spinner aria-label="加载中" />}>
        <SignUpPanel />
      </Suspense>
    </AuthPageShell>
  );
}
