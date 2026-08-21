import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { type AuthGateway, createAuthRoutes } from "./modules/auth/index.js";
import { healthRoutes } from "./modules/health/index.js";
import { clientIpMiddleware } from "./shared/client-ip.js";
import { AppError, onError, onNotFound } from "./shared/errors.js";
import { type RateLimiter, type RateLimitRule, rateLimitMiddleware } from "./shared/rate-limit.js";

// 依赖在进程入口构造后注入，组装层不 new 任何东西——否则测试无法替换。
export type AppDeps = {
  auth: AuthGateway;
  rateLimiter: RateLimiter;
  rateLimit: RateLimitRule;
  allowedOrigins: string[];
  trustedProxies: string[];
  maxBodyBytes: number;
};

// 健康检查不限流：编排系统会高频探活且来自少数几个 IP，限它等于自己制造"实例不健康"
const HEALTH_PATH = "/healthz";

// 组装层：全局中间件 + 按模块挂载路由。业务逻辑不出现在这里。
export const createApp = (deps: AppDeps) => {
  const app = new Hono();

  app.onError(onError);
  app.notFound(onNotFound);

  // 浏览器端要带 cookie，只能逐个白名单源，不能用通配符
  app.use(
    "*",
    cors({
      origin: deps.allowedOrigins,
      credentials: true,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
      maxAge: 600,
    }),
  );

  // 信任边界：解析真实客户端 IP，必须排在所有限流之前
  app.use("*", clientIpMiddleware(deps.trustedProxies));

  // 本服务自有端点的限流。better-auth 的限流只管它自己的 /api/auth/*，
  // /api/me 这类端点得由这里兜住（security.md：所有对外 endpoint 有限流）。
  // 放在 bodyLimit 之前：滥用方的请求体根本不用读。
  app.use(
    "*",
    rateLimitMiddleware({
      limiter: deps.rateLimiter,
      rule: deps.rateLimit,
      isExempt: (path) => path === HEALTH_PATH,
    }),
  );

  // 全局请求体上限（覆盖 /api/auth/* 在内的所有路由）
  app.use(
    "*",
    bodyLimit({
      maxSize: deps.maxBodyBytes,
      onError: () => {
        throw new AppError(413, "PAYLOAD_TOO_LARGE", "request body too large");
      },
    }),
  );

  app.route("/", healthRoutes);
  app.route("/", createAuthRoutes(deps.auth));

  return app;
};

export type App = ReturnType<typeof createApp>;
