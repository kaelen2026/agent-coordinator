import { Hono } from "hono";
import { healthRoutes } from "./modules/health/index.js";
import { onError, onNotFound } from "./shared/errors.js";

// 组装层：全局中间件 + 按模块挂载路由。业务逻辑不出现在这里。
export const createApp = () => {
  const app = new Hono();

  app.onError(onError);
  app.notFound(onNotFound);

  app.route("/", healthRoutes);

  return app;
};

export type App = ReturnType<typeof createApp>;
