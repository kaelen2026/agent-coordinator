import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col items-start justify-center gap-6 p-8">
      <div className="flex flex-col gap-2">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Agent Coordinator</h1>
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
