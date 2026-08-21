import { lt, sql } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { type ClientIpEnv, UNKNOWN_CLIENT_IP } from "./client-ip.js";
import type { Db } from "./db.js";
import { AppError } from "./errors.js";
import { apiRateLimit } from "./rate-limit.schema.js";

export type RateLimitRule = { windowSeconds: number; max: number };
export type RateLimitDecision = { allowed: boolean; retryAfterSeconds: number };
export type RateLimiter = (key: string, rule: RateLimitRule) => Promise<RateLimitDecision>;

// upsert 的 RETURNING 回来的是驱动给的原始行，按外部数据对待：先校验再用
const consumeRowSchema = z.object({
  count: z.coerce.number().int().positive(),
  window_started_at: z.coerce.date(),
});

/**
 * 固定窗口计数器，计数落库。
 *
 * 关键在于「读-改-写」压缩成一条 `INSERT ... ON CONFLICT DO UPDATE`：并发请求会在
 * 同一行上排队，不会各自读到同一个旧值然后一起放行。分两步做（先 SELECT 再 UPDATE）
 * 在并发下必然超发。
 *
 * 时间由调用方注入而不是用数据库的 `now()`：这样过期逻辑可以用假时钟测试，不必 sleep。
 * 代价是**依赖各实例的系统时钟大致同步（NTP）**——多实例间的偏差直接变成窗口边界的
 * 抖动。对 60 秒量级的窗口，秒级偏差可以忽略；真出现分钟级漂移应当先修 NTP。
 */
export type RateLimiterOptions = {
  now?: () => Date;
  /**
   * 过期行保留多久。**与限流规则的窗口解耦**：如果拿"当前这条规则的窗口"当
   * cutoff，将来给某条路径挂一条更长窗口的规则时，短窗口那次请求的清理会把
   * 长窗口尚未过期的桶一起删掉，等于静默放行。取一个远大于任何窗口的值。
   */
  retentionSeconds?: number;
  /** 两次清理之间的最小间隔——清理不能跑在每个请求的关键路径上。 */
  pruneEveryMs?: number;
};

const DEFAULT_RETENTION_SECONDS = 24 * 60 * 60;
const DEFAULT_PRUNE_EVERY_MS = 60_000;

export const createRateLimiter = (db: Db, options: RateLimiterOptions = {}): RateLimiter => {
  const now = options.now ?? (() => new Date());
  const retentionSeconds = options.retentionSeconds ?? DEFAULT_RETENTION_SECONDS;
  const pruneEveryMs = options.pruneEveryMs ?? DEFAULT_PRUNE_EVERY_MS;
  // 进程本地的节流游标。它只决定"这个进程什么时候顺手跑一次清理"，
  // 不参与限流判定，因此不算把状态放进了进程（判定状态仍然全在库里）。
  let nextPruneAt = 0;

  return async (key, rule) => {
    const at = now();
    const windowStart = new Date(at.getTime() - rule.windowSeconds * 1000);

    const result = await db.execute(sql`
      insert into ${apiRateLimit} ("key", "count", "window_started_at")
      values (${key}, 1, ${at})
      on conflict ("key") do update set
        "count" = case
          when ${apiRateLimit}."window_started_at" <= ${windowStart} then 1
          else ${apiRateLimit}."count" + 1
        end,
        "window_started_at" = case
          when ${apiRateLimit}."window_started_at" <= ${windowStart} then ${at}
          else ${apiRateLimit}."window_started_at"
        end
      returning "count", "window_started_at"
    `);

    const row = consumeRowSchema.parse(result.rows[0]);
    const windowEndsAt = row.window_started_at.getTime() + rule.windowSeconds * 1000;

    // 按时间节流地清理。之前挂在 `count === 1` 上是错的：每个新键的首个请求都满足
    // 它，未匹配路径洪水下就变成"每个请求一次全表条件 DELETE"，是放大而不是缓解。
    if (at.getTime() >= nextPruneAt) {
      nextPruneAt = at.getTime() + pruneEveryMs;
      await pruneExpiredRateLimits(db, at, retentionSeconds);
    }

    return {
      allowed: row.count <= rule.max,
      retryAfterSeconds: Math.max(1, Math.ceil((windowEndsAt - at.getTime()) / 1000)),
    };
  };
};

/** 清掉早已过期、不可能再拒绝任何请求的旧窗口，防止长尾客户端 IP 堆积。 */
export const pruneExpiredRateLimits = async (
  db: Db,
  now: Date,
  retentionSeconds: number,
): Promise<void> => {
  const cutoff = new Date(now.getTime() - retentionSeconds * 1000);
  await db.delete(apiRateLimit).where(lt(apiRateLimit.windowStartedAt, cutoff));
};

export type RateLimitOptions = {
  limiter: RateLimiter;
  rule: RateLimitRule;
  /** 返回 true 的路由不限流（如健康检查——被限流会让编排系统误判实例不健康）。 */
  isExempt?: (route: string) => boolean;
};

/** 没有命中任何路由的请求共用这个桶。 */
export const UNMATCHED_ROUTE = "<unmatched>";

const WILDCARD_ROUTE = "/*";

/**
 * 分桶用**命中的路由**而不是原始请求路径。
 *
 * 用原始路径的话，键空间由攻击者控制：`/no-such-route-<i>` 每换一个后缀就是一个新桶，
 * 于是 404 洪水既限不住，还会在限流表里每个请求堆一行。用路由就把它们全部收敛到
 * 同一个桶（未匹配的收敛到 UNMATCHED_ROUTE，`/api/auth/` 下的未知子路径收敛到 `/api/auth/*`）。
 */
const routeKeyOf = (c: Context): string => {
  // matchedRoutes 里既有全局中间件（注册路径都是 /*）也有真正的路由；
  // 取最后一个非 /* 的条目就是命中的路由，一个都没有说明没匹配上。
  const matched = c.req.matchedRoutes.filter((route) => route.path !== WILDCARD_ROUTE);
  return matched[matched.length - 1]?.path ?? UNMATCHED_ROUTE;
};

/**
 * 按「客户端 IP + 路径」限流本服务自有端点。
 * better-auth 的限流只覆盖它自己的 `/api/auth/*`，`/api/me` 这类自有端点得由这里兜住。
 */
export const rateLimitMiddleware = ({ limiter, rule, isExempt }: RateLimitOptions) =>
  createMiddleware<ClientIpEnv>(async (c, next) => {
    const route = routeKeyOf(c);
    if (isExempt?.(route) === true) {
      await next();
      return;
    }

    const clientIp = c.get("clientIp") ?? UNKNOWN_CLIENT_IP;
    const decision = await limiter(`${clientIp}|${route}`, rule);

    if (!decision.allowed) {
      throw new AppError(429, "RATE_LIMITED", "too many requests", [], {
        "Retry-After": String(decision.retryAfterSeconds),
      });
    }

    await next();
  });
