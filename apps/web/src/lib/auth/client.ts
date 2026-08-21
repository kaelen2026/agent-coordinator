import { createAuthClient } from "better-auth/react";
import { getApiBaseUrl } from "../env";

/**
 * better-auth 官方客户端，全局唯一实例。
 *
 * 会话完全依赖 api 下发的 HttpOnly cookie：客户端读不到、也不需要读，
 * 任何 token 都不进 localStorage / sessionStorage / 日志（security.md）。
 * 跨源请求必须带 cookie，所以 `credentials: "include"`（库默认如此，这里写明以免被改掉）。
 */
export const authClient = createAuthClient({
  baseURL: getApiBaseUrl(),
  // 与 apps/api 的 AUTH_BASE_PATH 一致，是契约的一部分
  basePath: "/api/auth",
  fetchOptions: {
    credentials: "include",
    // better-auth 在创建客户端时就把 `globalThis.fetch` 抓走了。这里包一层在**调用时**
    // 才解析 `fetch`：生产环境行为完全不变，测试则可以只 stub 这唯一的外部边界，
    // 让「客户端 → 契约 schema → 失败归类」整条链路跑真实代码。
    customFetchImpl: (input, init) => fetch(input, init),
  },
});
