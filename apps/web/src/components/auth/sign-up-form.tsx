"use client";

import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { signUp } from "@/lib/auth/actions";
import { PASSWORD_MIN_LENGTH, signUpSchema } from "@/lib/auth/forms";
import { AuthField } from "./auth-field";
import { FailureAlert } from "./failure-alert";
import { useAuthForm } from "./use-auth-form";

export function SignUpForm({ onSuccess }: { onSuccess: () => void }) {
  const { state, handleSubmit, clearFailure } = useAuthForm({
    schema: signUpSchema,
    submit: signUp,
    operation: "sign-up",
    onSuccess,
  });

  const blocked = state.submitting || state.failure?.kind === "rate-limited";

  return (
    <form onSubmit={handleSubmit} noValidate>
      <FieldGroup>
        {state.failure !== null && (
          <FailureAlert failure={state.failure} onRateLimitExpire={clearFailure} />
        )}
        <AuthField id="name" label="姓名" autoComplete="name" error={state.fieldErrors.name} />
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
          autoComplete="new-password"
          error={state.fieldErrors.password}
          aria-describedby="password-hint"
        />
        <p id="password-hint" className="text-muted-foreground text-sm">
          至少 {PASSWORD_MIN_LENGTH} 位。
        </p>
        <Button type="submit" disabled={blocked}>
          {state.submitting ? "注册中…" : "注册"}
        </Button>
      </FieldGroup>
    </form>
  );
}
