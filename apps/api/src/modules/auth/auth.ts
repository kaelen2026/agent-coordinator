import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { CLIENT_IP_HEADER } from "../../shared/client-ip.js";
import type { Db } from "../../shared/db.js";
import { createAuthLogger } from "./logger.js";
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

/** 本模块自己需要的配置形状，不直接吃全局 AppConfig，免得模块跟着全局配置漂移。 */
export type AuthConfig = {
  secret: string;
  baseUrl: string;
  trustedOrigins: string[];
  crossSiteCookies: boolean;
};

/** 在进程入口构造一次；密码哈希、会话、限流全部交给 better-auth，不自行实现。 */
export const createAuth = (db: Db, config: AuthConfig) =>
  betterAuth({
    // debugLogs 保持关闭。实测当前版本开了也不打邮箱等凭证，但它走的是
    // `console.log(...log)` 的**字符串**形态，console 防护看不进字符串内部；
    // 形态一旦随升级变化就会绕过防护，所以显式钉死为 false（纵深防御，无测试覆盖）。
    database: drizzleAdapter(db, { provider: "pg", schema, debugLogs: false }),
    // 默认 logger 会把 drizzle 错误里的查询参数（含会话 token）原样打进日志
    logger: createAuthLogger(),
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
      // 必须显式写死 false：不写的话 better-auth 在 NODE_ENV=test 下会**整体关掉**
      // origin/CSRF 校验（create-context.mjs 的 skipOriginCheck），
      // 于是测试跑的是与生产不同的分支，trustedOrigins 配错也照样绿。
      disableOriginCheck: false,
      // 只认信任边界写入的内部头。clientIpMiddleware 会覆盖客户端自带的同名头，
      // 所以这里拿到的 IP 与本服务限流用的完全一致，也不会被伪造。
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      defaultCookieAttributes: config.crossSiteCookies
        ? { sameSite: "none", secure: true, partitioned: true }
        : { sameSite: "lax" },
    },
  });
