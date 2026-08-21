import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createAuth } from "./modules/auth/index.js";
import { createDb, createPool } from "./shared/db.js";
import { loadConfig } from "./shared/env.js";
import { createRateLimiter } from "./shared/rate-limit.js";

// 进程入口：读配置 → 构造外部依赖 → 注入组装层 → 监听。业务逻辑不在这里。
// 配置非法直接抛出，进程起不来（fail fast），不带病运行。
const config = loadConfig();

const pool = createPool(config.db);
const db = createDb(pool);

const app = createApp({
  auth: createAuth(db, config.auth),
  rateLimiter: createRateLimiter(db),
  rateLimit: config.rateLimit,
  allowedOrigins: config.auth.trustedOrigins,
  trustedProxies: config.auth.trustedProxies,
  maxBodyBytes: config.http.maxBodyBytes,
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(JSON.stringify({ msg: "api listening", port: info.port }));
});

const shutdown = (signal: string) => {
  console.log(JSON.stringify({ msg: "api shutting down", signal }));
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
