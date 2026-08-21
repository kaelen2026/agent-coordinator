import type { MeResponse } from "@agent-coordinator/contracts";
import { Hono } from "hono";
import { AUTH_BASE_PATH, type AuthGateway } from "./auth.js";
import { type AuthEnv, requireAuth } from "./middleware.js";
import type { ReadSession } from "./service.js";

// 路由层只做挂载/解析/序列化；业务判断在 service，无 if。
export const createAuthRoutes = (auth: AuthGateway) => {
  const readSession: ReadSession = (headers) => auth.api.getSession({ headers });

  return (
    new Hono<AuthEnv>()
      // better-auth 自带的 sign-up / sign-in / sign-out / get-session 等由库定义
      .on(["GET", "POST"], `${AUTH_BASE_PATH}/*`, (c) => auth.handler(c.req.raw))
      .get("/api/me", requireAuth(readSession), (c) => {
        const body: MeResponse = { user: c.get("authUser") };
        return c.json(body);
      })
  );
};
