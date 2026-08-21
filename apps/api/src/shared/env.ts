import { z } from "zod";

// 配置只在这里解析一次：进程启动即失败（fail fast），业务代码拿到的是已校验的类型安全对象。
// 任何地址/端口/密钥都不许硬编码在别处（architecture.md 配置与依赖注入）。

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();
const boolFlag = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const csvList = (schema: z.ZodString) =>
  z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    )
    .pipe(z.array(schema));

const csvOrigins = z
  .string()
  .default("http://localhost:3000")
  .transform((value) =>
    value
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  )
  .pipe(z.array(z.string().url()).nonempty());

const envSchema = z.object({
  PORT: port.default(3001),
  DATABASE_URL: z.string().min(1),
  // 无默认值：缺失即启动失败。密钥只来自环境，不进代码/配置/夹具（security.md）。
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:3001"),
  AUTH_TRUSTED_ORIGINS: csvOrigins,
  // web 与 api 不同站点时必须开：cookie 需要 SameSite=None; Secure; Partitioned
  AUTH_COOKIE_CROSS_SITE: boolFlag,
  // 反向代理/负载均衡的 IP 或 CIDR。留空则不信任 X-Forwarded-For 链，
  // 限流会退化成全局共享桶——部署在代理后面时必须配置（见 README/.env.example）。
  AUTH_TRUSTED_PROXIES: csvList(z.string().min(1)),
  DB_POOL_MAX: positiveInt.default(10),
  DB_CONNECTION_TIMEOUT_MS: positiveInt.default(5_000),
  DB_STATEMENT_TIMEOUT_MS: positiveInt.default(10_000),
  HTTP_MAX_BODY_BYTES: positiveInt.default(16 * 1024),
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
  auth: {
    secret: string;
    baseUrl: string;
    trustedOrigins: string[];
    crossSiteCookies: boolean;
    trustedProxies: string[];
  };
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
  return {
    port: env.PORT,
    db: {
      url: env.DATABASE_URL,
      poolMax: env.DB_POOL_MAX,
      connectionTimeoutMs: env.DB_CONNECTION_TIMEOUT_MS,
      statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
    },
    http: { maxBodyBytes: env.HTTP_MAX_BODY_BYTES },
    auth: {
      secret: env.BETTER_AUTH_SECRET,
      baseUrl: env.BETTER_AUTH_URL,
      trustedOrigins: env.AUTH_TRUSTED_ORIGINS,
      crossSiteCookies: env.AUTH_COOKIE_CROSS_SITE,
      trustedProxies: env.AUTH_TRUSTED_PROXIES,
    },
  };
};
