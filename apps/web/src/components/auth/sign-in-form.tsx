"use client";

import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { signIn } from "@/lib/auth/actions";
import { signInSchema } from "@/lib/auth/forms";
import { AuthField } from "./auth-field";
import { FailureAlert } from "./failure-alert";
import { useAuthForm } from "./use-auth-form";

export function SignInForm({ onSuccess }: { onSuccess: () => void }) {
  const { state, handleSubmit, clearFailure } = useAuthForm({
    schema: signInSchema,
    submit: signIn,
    operation: "sign-in",
    onSuccess,
  });

  // 被限流期间禁用提交：再点也只会继续吃 429，把窗口越拖越长。
  const blocked = state.submitting || state.failure?.kind === "rate-limited";

  return (
    <form onSubmit={handleSubmit} noValidate>
      <FieldGroup>
        {state.failure !== null && (
          <FailureAlert failure={state.failure} onRateLimitExpire={clearFailure} />
        )}
        <AuthField
          id="email"
          label="邮箱"
          type="email"
          autoComplete="email"
          error={state.fieldErrors.email}
        />
        <AuthField
          id="password"
          label="密码"
          type="password"
          autoComplete="current-password"
          error={state.fieldErrors.password}
        />
        <Button type="submit" disabled={blocked}>
          {state.submitting ? "登录中…" : "登录"}
        </Button>
      </FieldGroup>
    </form>
  );
}
