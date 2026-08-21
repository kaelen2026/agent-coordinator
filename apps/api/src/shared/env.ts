import { findInvalidTrustedProxies } from "@better-auth/core/utils/ip";
import { z } from "zod";

// 配置只在这里解析一次：进程启动即失败（fail fast），业务代码拿到的是已校验的类型安全对象。
// 任何地址/端口/密钥都不许硬编码在别处（architecture.md 配置与依赖注入）。

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();
const boolFlag = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

// 部署系统里"变量设成空串"和"变量没设"是一回事，都按未声明处理
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    schema.optional(),
  );

const csvItems = (value: string): string[] =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

/** 声明"本服务直连暴露、前面没有任何代理"。必须显式写出来，不允许靠留空蒙混。 */
const TRUSTED_PROXIES_NONE = "none";

const DEV_BASE_URL = "http://localhost:3001";
const DEV_TRUSTED_ORIGINS = ["http://localhost:3000"];

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: port.default(3001),
  DATABASE_URL: z.string().min(1),
  // 无默认值：缺失即启动失败。密钥只来自环境，不进代码/配置/夹具（security.md）
  BETTER_AUTH_SECRET: z.string().min(32),
  // 下面三个在生产没有默认值——兜底成开发值的后果见 loadConfig 里的 requireInProduction
  BETTER_AUTH_URL: optional(z.string().url()),
  AUTH_TRUSTED_ORIGINS: optional(z.string()),
  AUTH_TRUSTED_PROXIES: optional(z.string()),
  // web 与 api 不同站点时必须开：cookie 需要 SameSite=None; Secure; Partitioned
  AUTH_COOKIE_CROSS_SITE: boolFlag,
  DB_POOL_MAX: positiveInt.default(10),
  DB_CONNECTION_TIMEOUT_MS: positiveInt.default(5_000),
  DB_STATEMENT_TIMEOUT_MS: positiveInt.default(10_000),
  HTTP_MAX_BODY_BYTES: positiveInt.default(16 * 1024),
  API_RATE_LIMIT_WINDOW_SECONDS: positiveInt.default(60),
  API_RATE_LIMIT_MAX: positiveInt.default(120),
});

export type AppConfig = {
  port: number;
  db: {
    url: string;
    poolMax: number;
    connectionTimeoutMs: number;
    statementTimeoutMs: number;
  };
  http: { maxBodyBytes: number };
  rateLimit: { windowSeconds: number; max: number };
  auth: {
    secret: string;
    baseUrl: string;
    trustedOrigins: string[];
    crossSiteCookies: boolean;
    trustedProxies: string[];
  };
};

type Issue = { variable: string; reason: string };

const parseTrustedOrigins = (raw: string, issues: Issue[]): string[] => {
  const origins = csvItems(raw);
  const invalid = origins.filter((origin) => !z.string().url().safeParse(origin).success);
  if (invalid.length > 0) {
    issues.push({ variable: "AUTH_TRUSTED_ORIGINS", reason: `not a URL: ${invalid.join(", ")}` });
  }
  if (origins.length === 0) {
    issues.push({ variable: "AUTH_TRUSTED_ORIGINS", reason: "must list at least one origin" });
  }
  return origins;
};

/**
 * 可信代理列表决定限流怎么分桶，漏配或写错都会让全站退化成一个共享桶
 * （攻击者 3 个请求就能把所有人挡在登录门外），所以这里只接受两种明确表态：
 * `none`（直连暴露）或一串能解析的 IP / CIDR。
 */
const parseTrustedProxies = (raw: string, issues: Issue[]): string[] => {
  if (raw.trim() === TRUSTED_PROXIES_NONE) {
    return [];
  }
  const entries = csvItems(raw);
  if (entries.length === 0) {
    issues.push({
      variable: "AUTH_TRUSTED_PROXIES",
      reason: `must be "${TRUSTED_PROXIES_NONE}" or a comma-separated list of IPs / CIDR ranges`,
    });
    return [];
  }
  // better-auth 会把解析不了的条目静默过滤掉，结果又是共享桶——所以启动期就拦下来
  const invalid = findInvalidTrustedProxies(entries);
  if (invalid.length > 0) {
    issues.push({
      variable: "AUTH_TRUSTED_PROXIES",
      reason: `not an IP address or CIDR range: ${invalid.join(", ")}`,
    });
  }
  return entries;
};

export const loadConfig = (source: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    // 只报变量名与原因，不回显取值——DATABASE_URL 等本身含凭证（security.md）
    const reasons = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid environment configuration -> ${reasons}`);
  }

  const env = parsed.data;
  const isProduction = env.NODE_ENV === "production";
  const issues: Issue[] = [];

  const requireInProduction = (variable: string, value: string | undefined, why: string): void => {
    if (isProduction && value === undefined) {
      issues.push({ variable, reason: `required in production (${why})` });
    }
  };

  // baseURL 的 scheme 决定 cookie 的 Secure 标志与 __Secure- 前缀：生产兜底成 http
  // 会让 https 站点发出不带 Secure 的会话 cookie，所以宁可起不来
  requireInProduction("BETTER_AUTH_URL", env.BETTER_AUTH_URL, "决定 cookie 的 Secure 属性");
  requireInProduction("AUTH_TRUSTED_ORIGINS", env.AUTH_TRUSTED_ORIGINS, "是 CSRF/CORS 信任清单");
  requireInProduction("AUTH_TRUSTED_PROXIES", env.AUTH_TRUSTED_PROXIES, "决定限流如何分桶");

  const trustedOrigins =
    env.AUTH_TRUSTED_ORIGINS === undefined
      ? DEV_TRUSTED_ORIGINS
      : parseTrustedOrigins(env.AUTH_TRUSTED_ORIGINS, issues);

  const trustedProxies =
    env.AUTH_TRUSTED_PROXIES === undefined
      ? []
      : parseTrustedProxies(env.AUTH_TRUSTED_PROXIES, issues);

  if (issues.length > 0) {
    const reasons = issues.map((issue) => `${issue.variable}: ${issue.reason}`).join("; ");
    throw new Error(`invalid environment configuration -> ${reasons}`);
  }

  return {
    port: env.PORT,
    db: {
      url: env.DATABASE_URL,
      poolMax: env.DB_POOL_MAX,
      connectionTimeoutMs: env.DB_CONNECTION_TIMEOUT_MS,
      statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
    },
    http: { maxBodyBytes: env.HTTP_MAX_BODY_BYTES },
    rateLimit: {
      windowSeconds: env.API_RATE_LIMIT_WINDOW_SECONDS,
      max: env.API_RATE_LIMIT_MAX,
    },
    auth: {
      secret: env.BETTER_AUTH_SECRET,
      baseUrl: env.BETTER_AUTH_URL ?? DEV_BASE_URL,
      trustedOrigins,
      crossSiteCookies: env.AUTH_COOKIE_CROSS_SITE,
      trustedProxies,
    },
  };
};
