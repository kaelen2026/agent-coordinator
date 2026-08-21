"use client";

import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { rateLimitMessage } from "@/lib/auth/messages";

/**
 * 限流倒计时。秒数来自服务端响应头（`X-Retry-After` / `Retry-After`），
 * **不是**写死的常量——契约里写明那些数字随配置变化。
 */
export function RateLimitNotice({
  retryAfterSeconds,
  onExpire,
}: {
  retryAfterSeconds: number;
  onExpire: () => void;
}) {
  const [remaining, setRemaining] = useState(retryAfterSeconds);

  // 订阅外部系统（计时器）——useEffect 的正当用途。
  useEffect(() => {
    setRemaining(retryAfterSeconds);

    const timer = setInterval(() => {
      setRemaining((current) => Math.max(0, current - 1));
    }, 1000);

    return () => clearInterval(timer);
  }, [retryAfterSeconds]);

  useEffect(() => {
    if (remaining === 0) onExpire();
  }, [remaining, onExpire]);

  return (
    <Alert variant="destructive" role="alert">
      <AlertDescription>{rateLimitMessage(remaining)}</AlertDescription>
    </Alert>
  );
}
