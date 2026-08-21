"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { safeRedirectTarget } from "@/lib/auth/redirect";
import { SignInForm } from "./sign-in-form";

/**
 * 把登录表单接到路由上。`redirectTo` 来自 URL，是不可信输入，
 * 一律经 safeRedirectTarget 消毒后才拿去跳转。
 */
export function SignInPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const target = safeRedirectTarget(searchParams.get("redirectTo"));

  // 用 replace 而不是 push：登录页不该留在历史里，否则回退又回到登录页。
  const handleSuccess = useCallback(() => {
    router.replace(target);
  }, [router, target]);

  return <SignInForm onSuccess={handleSuccess} />;
}
