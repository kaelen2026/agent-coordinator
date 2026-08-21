"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import type { AuthFailure } from "@/lib/auth/failure";
import { authFailureMessage } from "@/lib/auth/messages";
import { RateLimitNotice } from "./rate-limit-notice";

/**
 * 失败态的统一呈现。限流单独走带倒计时的分支，其余分支只是一句文案——
 * 文案本身由 lib/auth/messages 统一维护，组件不自己拼措辞。
 */
export function FailureAlert({
  failure,
  onRateLimitExpire,
}: {
  failure: AuthFailure;
  onRateLimitExpire: () => void;
}) {
  if (failure.kind === "rate-limited") {
    return (
      <RateLimitNotice retryAfterSeconds={failure.retryAfterSeconds} onExpire={onRateLimitExpire} />
    );
  }

  return (
    <Alert variant="destructive" role="alert">
      <AlertDescription>{authFailureMessage(failure)}</AlertDescription>
    </Alert>
  );
}
