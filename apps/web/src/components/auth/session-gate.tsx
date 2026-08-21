"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { AuthFailure } from "@/lib/auth/failure";
import { authFailureMessage } from "@/lib/auth/messages";
import { signInPathFor } from "@/lib/auth/redirect";

/**
 * 受保护内容的四态壳子。刻意做成纯展示 + 一个跳转副作用，会话从哪来由外部决定，
 * 于是四态各自都能被确定性地测到。
 */
export type SessionGateState =
  | { status: "loading" }
  | { status: "error"; failure: AuthFailure }
  | { status: "anonymous" }
  | { status: "authenticated" };

export function SessionGate({
  state,
  onRetry,
  children,
}: {
  state: SessionGateState;
  onRetry: () => void;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const signInHref = useMemo(() => signInPathFor(pathname), [pathname]);

  // 同步外部系统（路由）——useEffect 的正当用途。
  // 只有"确定未登录"才跳转：读会话失败时把用户踢去登录页，等于把一次网络抖动
  // 变成一次莫名其妙的登出。
  useEffect(() => {
    if (state.status === "anonymous") router.replace(signInHref);
  }, [state.status, router, signInHref]);

  if (state.status === "authenticated") return <>{children}</>;

  if (state.status === "loading") {
    return (
      <output className="text-muted-foreground flex items-center gap-2 text-sm">
        <Spinner aria-hidden="true" />
        正在确认登录状态…
      </output>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex flex-col items-start gap-3">
        <Alert variant="destructive" role="alert">
          <AlertDescription>{authFailureMessage(state.failure)}</AlertDescription>
        </Alert>
        <Button type="button" variant="outline" onClick={onRetry}>
          重试
        </Button>
      </div>
    );
  }

  // anonymous：跳转是异步的，这一帧仍要给出可见内容，不能白屏；
  // 同时留一个手动入口，跳转被拦截时用户仍走得下去。
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-muted-foreground text-sm">这个页面需要登录后才能查看。</p>
      <Button type="button" render={<Link href={signInHref}>前往登录</Link>} />
    </div>
  );
}
