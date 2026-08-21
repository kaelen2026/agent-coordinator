import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Db } from "../../shared/db.js";
import type { AppConfig } from "../../shared/env.js";
import * as schema from "./schema.js";
import type { SessionUser } from "./service.js";

/** better-auth 的挂载前缀。是对外契约的一部分，不随环境变化，所以是常量不是配置项。 */
export const AUTH_BASE_PATH = "/api/auth";

/**
 * 路由层依赖的最小认证能力面。better-auth 实例在结构上满足它，
 * 因此生产直接注入实例，测试注入假实现——不需要跑数据库就能测路由装配。
 */
export type AuthGateway = {
  handler: (request: Request) => Promise<Response>;
  api: {
    getSession: (options: { headers: Headers }) => Promise<{ user: SessionUser } | null>;
  };
};

/** 在进程入口构造一次；密码哈希、会话、限流全部交给 better-auth，不自行实现。 */
export const createAuth = (db: Db, config: AppConfig["auth"]) =>
  betterAuth({
    database: drizzleAdapter(db, { provider: "pg", schema }),
    secret: config.secret,
    baseURL: config.baseUrl,
    basePath: AUTH_BASE_PATH,
    trustedOrigins: config.trustedOrigins,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      // 本切片不做邮箱验证/找回密码，注册后直接建立会话
      requireEmailVerification: false,
      autoSignIn: true,
    },
    // 限流计数落库：进程无状态，多实例共享同一份计数
    rateLimit: { enabled: true, storage: "database" },
    advanced: {
      // 只有配置了可信代理才从 X-Forwarded-For 取客户端 IP，否则头可被伪造
      ipAddress: { trustedProxies: config.trustedProxies },
      defaultCookieAttributes: config.crossSiteCookies
        ? { sameSite: "none", secure: true, partitioned: true }
        : { sameSite: "lax" },
    },
  });
