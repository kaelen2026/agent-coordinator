import type { AuthUser } from "@agent-coordinator/contracts";
import { createMiddleware } from "hono/factory";
import { getCurrentUser, type ReadSession } from "./service.js";

export type AuthEnv = { Variables: { authUser: AuthUser } };

/**
 * 受保护路由的准入：无有效会话直接抛 UNAUTHENTICATED（默认拒绝，不静默放行）。
 * 通过后把已白名单化的用户挂到 context，下游不再自己读会话。
 */
export const requireAuth = (readSession: ReadSession) =>
  createMiddleware<AuthEnv>(async (c, next) => {
    c.set("authUser", await getCurrentUser(readSession, c.req.raw.headers));
    await next();
  });
