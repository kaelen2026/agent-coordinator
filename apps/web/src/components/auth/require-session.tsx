"use client";

import type { ReactNode } from "react";
import { authClient } from "@/lib/auth/client";
import { classifyAuthFailure, networkFailure } from "@/lib/auth/failure";
import { SessionGate, type SessionGateState } from "./session-gate";

/**
 * 会话读取结果 → 四态。抽成纯函数，四条分支都能被确定性地测到。
 *
 * 关键规则：**出错不等于未登录**。把读会话失败降级成"未登录"会让一次网络抖动
 * 表现为莫名其妙的登出，还会顺手把用户踢出正在填的页面。
 */
export const toGateState = ({
  isPending,
  error,
  hasSession,
}: {
  isPending: boolean;
  error: { status: number } | null;
  hasSession: boolean;
}): SessionGateState => {
  if (error !== null) {
    // 这里拿不到响应头，限流秒数会退回本端默认值——会话轮询不是用户主动操作，
    // 少几秒精度不影响体验。
    const failure =
      error.status > 0
        ? classifyAuthFailure({ status: error.status, body: null, headers: new Headers() })
        : networkFailure();
    return { status: "error", failure };
  }

  if (isPending) return { status: "loading" };
  if (hasSession) return { status: "authenticated" };
  return { status: "anonymous" };
};

/**
 * 受保护页面的守卫。
 *
 * **为什么放在客户端而不是 Next 服务端**：会话 cookie 由 api 下发。本地 web 与 api
 * 同为 localhost（cookie 忽略端口）所以服务端也读得到，但那只是同站的巧合——生产环境
 * web 与 api 一旦不同站，浏览器根本不会把该 cookie 发给 web，Next 服务端会永远看到
 * "未登录"；何况 Next 侧没有 BETTER_AUTH_SECRET，读到了也无法验签。
 * 客户端守卫在同站与跨站部署下行为一致，不会静默失效。真正的鉴权始终在 api 侧，
 * 这里只负责别把受保护界面渲染给没登录的人。
 */
export function RequireSession({ children }: { children: ReactNode }) {
  const { data, isPending, error, refetch } = authClient.useSession();

  const state = toGateState({
    isPending,
    error: error === null ? null : { status: error.status },
    hasSession: data !== null,
  });

  return (
    <SessionGate state={state} onRetry={() => void refetch()}>
      {children}
    </SessionGate>
  );
}
