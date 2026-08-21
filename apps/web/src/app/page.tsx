import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-5xl flex-col items-start justify-center gap-6 p-6">
      <div className="flex flex-col gap-2">
        {/* 页面标题：mono 20px 600；等宽字体不加负字距（DESIGN.md 第 3 节） */}
        <h1 className="font-heading text-xl font-semibold">Agent Coordinator</h1>
        <p className="text-muted-foreground text-sm">登录后查看你的账号信息。</p>
      </div>
      <div className="flex flex-wrap gap-3">
        <Link href="/sign-in" className={buttonVariants()}>
          登录
        </Link>
        <Link href="/sign-up" className={buttonVariants({ variant: "outline" })}>
          注册
        </Link>
        <Link href="/dashboard" className={buttonVariants({ variant: "ghost" })}>
          我的账号
        </Link>
      </div>
    </main>
  );
}
