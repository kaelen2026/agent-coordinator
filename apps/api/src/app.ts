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
      // Retry-After 不在 CORS 安全清单里，不显式 expose 浏览器就读不到，
      // 429 等于没告诉客户端该等多久。X-Retry-After 是 better-auth 自己用的名字。
      //
      // ⚠️ 这个清单**不能变空**（哪怕将来判断 web 不再需要限流倒计时也要留住它）：
      // hono 的 cors 只在清单非空时才在 next() 前把 `Access-Control-Expose-Headers` 写进
      // c.res.headers，随后 Hono 的 `set res` 把它盖回下游响应上——bearer plugin 自己往那个头里
      // 加的 `set-auth-token` 正是被这一步覆盖掉的（插件的 after hook 对每个建立会话的响应无条件
      // 执行，见 modules/auth/auth.ts 的注释）。清单一空，cors 整个不设这个头，插件的值直接透出去，
      // 跨源浏览器 JS 就能读到可复用的会话 token。auth.integration.test.ts 的
      // does_not_expose_the_token_header_to_cross_origin_browser_javascript 钉住这条。
      // 后续可选加固（本切片没做，属行为改动）：在没有 Authorization 请求头的响应上直接剥掉
      // set-auth-token，把保障从"被覆盖"变成"来源即无"。
      exposeHeaders: ["Retry-After", "X-Retry-After"],
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
      isExempt: (route) => route === HEALTH_PATH,
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
