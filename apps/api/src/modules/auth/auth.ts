import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins/bearer";
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
    // debugLogs 保持关闭：纯粹为了减少日志噪音 + 纵深防御。
    // （它把载荷作为**对象参数**交给 console，会被 shared/log-redaction 的防护收敛成
    // `[Object]`，实测凭证 0 泄漏——所以关闭它不是因为防护拦不住。）
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
    // 原生客户端（iOS）的凭证形态：会话 token 从 `set-auth-token` 响应头取，
    // 之后按 `Authorization: Bearer <token>` 发回。cookie 路径完全不受影响——
    // 插件只在请求带 Authorization 头时才介入。
    //
    // requireSignature 必须显式开：默认 false 时插件会**自己给没签名的 token 补上签名**，
    // 于是光有一个裸的会话 id（session.token 那一列的值）就能冒充用户——数据库只读权限、
    // 一次备份、一行日志都够了。我们下发的 token 一律带签名，所以开它不损失任何功能。
    // 行为由集成测试 "rejects_a_bare_session_id_that_carries_no_signature" 钉住。
    plugins: [bearer({ requireSignature: true })],
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
