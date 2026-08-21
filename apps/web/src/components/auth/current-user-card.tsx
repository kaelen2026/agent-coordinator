"use client";

import type { AuthUser } from "@agent-coordinator/contracts";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { fetchCurrentUser } from "@/lib/api/me";
import type { AuthFailure } from "@/lib/auth/failure";
import { authFailureMessage } from "@/lib/auth/messages";
import { SIGN_IN_PATH } from "@/lib/auth/redirect";
import { formatDateTime } from "@/lib/format";
import { reportAuthFailure } from "@/lib/observability/report";

/**
 * 展示 `/api/me` 返回的当前用户。
 *
 * 四态：加载 / 成功 / 未登录（=没有数据可展示时的引导态）/ 错误（含限流倒计时）。
 * `/api/me` 只要 200 就必定带一个用户，不存在"列表为空"意义上的空态，
 * 因此这里的"无数据"就是未登录，用引导而不是白屏兜住。
 */
type State =
  | { phase: "loading" }
  | { phase: "loaded"; user: AuthUser }
  | { phase: "failed"; failure: AuthFailure };

export function CurrentUserCard() {
  const [state, setState] = useState<State>({ phase: "loading" });
  const inFlight = useRef<AbortController | null>(null);

  // 取数本身是一个动作，不是"某个 state 变了要同步"：所以写成可直接调用的函数，
  // 挂载时由 effect 触发一次，重试时由事件处理器触发——不靠加一个假的依赖项来重跑 effect。
  const load = useCallback(() => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setState({ phase: "loading" });

    fetchCurrentUser(controller.signal)
      .then((result) => {
        if (result.ok) {
          setState({ phase: "loaded", user: result.data });
          return;
        }
        reportAuthFailure("me", result.failure);
        setState({ phase: "failed", failure: result.failure });
      })
      .catch(() => {
        // 只会是取消：组件已经不在了或又发起了新的一次，什么都不用做
      });
  }, []);

  // 订阅外部系统（api）：挂载时取一次，卸载时取消在途请求。
  useEffect(() => {
    load();
    return () => inFlight.current?.abort();
  }, [load]);

  if (state.phase === "loading") {
    return (
      <output className="text-muted-foreground flex items-center gap-2 text-sm">
        <Spinner aria-hidden="true" />
        正在加载账号信息…
      </output>
    );
  }

  if (state.phase === "failed") {
    return (
      <div className="flex flex-col items-start gap-3">
        <Alert variant="destructive" role="alert">
          <AlertDescription>{authFailureMessage(state.failure)}</AlertDescription>
        </Alert>
        {state.failure.kind === "unauthenticated" ? (
          <Button type="button" render={<Link href={SIGN_IN_PATH}>重新登录</Link>} />
        ) : (
          <Button type="button" variant="outline" onClick={load}>
            重试
          </Button>
        )}
      </div>
    );
  }

  return (
    <dl className="grid gap-3 text-sm">
      <div className="grid gap-0.5">
        <dt className="text-muted-foreground">姓名</dt>
        <dd className="font-medium">{state.user.name}</dd>
      </div>
      <div className="grid gap-0.5">
        <dt className="text-muted-foreground">邮箱</dt>
        <dd className="font-medium">{state.user.email}</dd>
      </div>
      <div className="grid gap-0.5">
        <dt className="text-muted-foreground">邮箱验证</dt>
        <dd className="font-medium">{state.user.emailVerified ? "已验证" : "未验证"}</dd>
      </div>
      <div className="grid gap-0.5">
        <dt className="text-muted-foreground">注册时间</dt>
        <dd className="font-medium">
          <time dateTime={state.user.createdAt}>{formatDateTime(state.user.createdAt)}</time>
        </dd>
      </div>
    </dl>
  );
}
