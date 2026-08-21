"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { safeRedirectTarget } from "@/lib/auth/redirect";
import { SignUpForm } from "./sign-up-form";

/** api 侧开了 autoSignIn，注册成功即已登录，直接跳落地页。 */
export function SignUpPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const target = safeRedirectTarget(searchParams.get("redirectTo"));

  const handleSuccess = useCallback(() => {
    router.replace(target);
  }, [router, target]);

  return <SignUpForm onSuccess={handleSuccess} />;
}
