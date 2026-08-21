"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { SIGN_IN_PATH } from "@/lib/auth/redirect";
import { CurrentUserCard } from "./current-user-card";
import { RequireSession } from "./require-session";
import { SignOutButton } from "./sign-out-button";

export function DashboardPanel() {
  const router = useRouter();

  const handleSignedOut = useCallback(() => {
    router.replace(SIGN_IN_PATH);
    // 客户端路由缓存里可能还留着登录态下渲染的内容，登出后刷一次
    router.refresh();
  }, [router]);

  return (
    <RequireSession>
      <div className="flex flex-col gap-6">
        <CurrentUserCard />
        <SignOutButton onSignedOut={handleSignedOut} />
      </div>
    </RequireSession>
  );
}
