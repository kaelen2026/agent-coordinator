import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createAuth } from "./modules/auth/index.js";
import { createDb, createPool } from "./shared/db.js";
import { loadConfig } from "./shared/env.js";
import { describeError, installConsoleRedaction } from "./shared/log-redaction.js";
import { createRateLimiter, retentionSecondsFor } from "./shared/rate-limit.js";

// 第一件事：装上 console 防护。必须早于任何依赖构造——库在初始化阶段就可能打日志，
// 而 better-call 之类把 console.error 硬编码在里面，只能在全局出口上拦。
installConsoleRedaction();

// Node 未捕获异常/未处理拒绝的默认打印是**直接写 stderr 的，不走 console**，
// 拦不到。所以自己接管：记脱敏摘要后按 fail-fast 退出，不带病继续。
process.on("uncaughtException", (error) => {
  console.error(JSON.stringify({ msg: "uncaught exception", error: describeError(error) }));
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error(JSON.stringify({ msg: "unhandled rejection", error: describeError(reason) }));
  process.exit(1);
});

// 进程入口：读配置 → 构造外部依赖 → 注入组装层 → 监听。业务逻辑不在这里。
// 配置非法直接抛出，进程起不来（fail fast），不带病运行。
const config = loadConfig();

const pool = createPool(config.db);
const db = createDb(pool);

const app = createApp({
  auth: createAuth(db, config.auth),
  rateLimiter: createRateLimiter(db, {
    retentionSeconds: retentionSecondsFor(config.rateLimit.windowSeconds),
  }),
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
