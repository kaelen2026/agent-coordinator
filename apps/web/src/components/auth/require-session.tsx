"use client";

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { authClient } from "@/lib/auth/client";
import { classifyAuthFailure, networkFailure } from "@/lib/auth/failure";
import { SessionGate, type SessionGateState } from "./session-gate";

/**
 * 会话读取结果 → 四态。抽成纯函数，四条分支都能被确定性地测到。
 *
 * 两条规则，本质是同一条——**只有确定的结论才能把人送去登录页**：
 *
 * 1. 出错不等于未登录。把读会话失败降级成"未登录"会让一次网络抖动表现为莫名登出。
 * 2. 缓存说没有 ≠ 确定没有。会话 store 是模块级缓存：用户匿名访问过一次受保护页之后，
 *    它就一直存着"无会话"，而且 better-auth 在重新挂载时会做去重（`freshUntil`）
 *    并把重新校验排进 `setTimeout(…, 0)`。于是登录成功后再进受保护页的那一瞬间，
 *    store 同步吐出来的是**陈旧的** `data=null`，此时 `isPending` 与 `isRefetching`
 *    双双为 false——光看这两个标志区分不出"确定未登录"和"还没来得及重新校验"。
 *    所以判定依据不是标志位，而是 `verified`：本次挂载亲自发起的那次读取有没有落地。
 */
export const toGateState = ({
  verified,
  isPending,
  error,
  hasSession,
}: {
  /** 本次挂载发起的会话读取是否已经有结果。false 表示结论还不可信。 */
  verified: boolean;
  isPending: boolean;
  error: { status: number } | null;
  hasSession: boolean;
}): SessionGateState => {
  if (error !== null) {
    // 这里拿不到响应头，限流秒数会退回本端默认值——会话校验不是用户主动操作，
    // 少几秒精度不影响体验。
    const failure =
      error.status > 0
        ? classifyAuthFailure({ status: error.status, body: null, headers: new Headers() })
        : networkFailure();
    return { status: "error", failure };
  }

  if (!verified || isPending) return { status: "loading" };
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
 *
 * **每次挂载都亲自校验一次会话**，不复用缓存结论：守卫的判定永远基于本次挂载发起的
 * 读取，不会被上一次匿名访问留下的缓存误导。
 *
 * 成本要按服务端口径算，别按浏览器口径算。`refetch()` 会取消 store 自己那次在途请求，
 * 所以**客户端只看到 1 个响应**；但取消发生在请求已经发出并到达 api 之后，
 * **api 的限流桶实打实记了 2 次**。也就是每进一次受保护页消耗 2 个 get-session 配额
 * （加上 CurrentUserCard 的 /api/me，一共 3 个出站请求）。
 * 按 better-auth 每 IP 每滚动分钟 100 次算，天花板是 50 次/分钟——真人点不到，
 * 机器全速点 3.6 秒就能撞上（实测第 51 次进入触发 429）。
 *
 * 撞上了也不会变成莫名登出：429 归 `classifyAuthFailure` 的 rate-limited 分支，
 * 走 SessionGate 的错误态（提示 + 重试入口），仍然不满足"确定未登录"，不会把人弹走。
 */
export function RequireSession({ children }: { children: ReactNode }) {
  const { data, isPending, error, refetch } = authClient.useSession();
  const [verified, setVerified] = useState(false);

  // refetch 由会话 store 提供，引用稳定，所以这个回调每次挂载只会跑一次。
  const verify = useCallback(() => {
    setVerified(false);
    void Promise.resolve(refetch()).finally(() => {
      // 组件已卸载时 setState 是空操作（React 18+ 不再告警），无需额外的存活标记
      setVerified(true);
    });
  }, [refetch]);

  // 订阅外部系统（会话 store）：挂载时强制校验一次。
  useEffect(() => {
    verify();
  }, [verify]);

  const state = toGateState({
    verified,
    isPending,
    error: error === null ? null : { status: error.status },
    hasSession: data !== null,
  });

  return (
    <SessionGate state={state} onRetry={verify}>
      {children}
    </SessionGate>
  );
}
