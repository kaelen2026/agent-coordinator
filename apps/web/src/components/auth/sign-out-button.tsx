"use client";

import { useCallback, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/auth/actions";
import type { AuthFailure } from "@/lib/auth/failure";
import { authFailureMessage } from "@/lib/auth/messages";
import { reportAuthFailure } from "@/lib/observability/report";

export function SignOutButton({ onSignedOut }: { onSignedOut: () => void }) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<AuthFailure | null>(null);

  const handleClick = useCallback(() => {
    setPending(true);
    setFailure(null);

    void signOut().then((result) => {
      setPending(false);
      if (result.ok) {
        onSignedOut();
        return;
      }
      // 登出失败就是没登出：不能本地清个状态假装成功，那会让用户以为自己安全了。
      reportAuthFailure("sign-out", result.failure);
      setFailure(result.failure);
    });
  }, [onSignedOut]);

  return (
    <div className="flex flex-col items-start gap-3">
      {failure !== null && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{authFailureMessage(failure)}</AlertDescription>
        </Alert>
      )}
      <Button type="button" variant="outline" onClick={handleClick} disabled={pending}>
        {pending ? "登出中…" : "登出"}
      </Button>
    </div>
  );
}
