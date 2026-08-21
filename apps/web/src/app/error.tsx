"use client";

import { useEffect } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/** 路由段级兜底：渲染期未捕获的异常不至于变成白屏。 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 只记录 digest（Next 生成的关联 id），不把原始 message 抛给用户
    console.error("[web] unhandled render error", { digest: error.digest });
  }, [error]);

  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-4 p-6">
      <Alert variant="destructive" role="alert">
        <AlertTitle>页面出错了</AlertTitle>
        <AlertDescription>请稍后重试；如果一直失败，请联系管理员。</AlertDescription>
      </Alert>
      <Button type="button" onClick={reset}>
        重试
      </Button>
    </main>
  );
}
