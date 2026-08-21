import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { type AuthGateway, createAuthRoutes } from "./modules/auth/index.js";
import { healthRoutes } from "./modules/health/index.js";
import { AppError, onError, onNotFound } from "./shared/errors.js";

// 依赖在进程入口构造后注入，组装层不 new 任何东西——否则测试无法替换。
export type AppDeps = {
  auth: AuthGateway;
  allowedOrigins: string[];
  maxBodyBytes: number;
};

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
