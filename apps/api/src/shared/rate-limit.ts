import { lt, sql } from "drizzle-orm";
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
 * 代价是多实例间有时钟偏差，对 60 秒量级的窗口可以忽略。
 */
export const createRateLimiter =
  (db: Db, now: () => Date = () => new Date()): RateLimiter =>
  async (key, rule) => {
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

    // 窗口刚翻新时顺手清一次过期行：每个键每个窗口最多触发一次，是带索引的删除
    if (row.count === 1) {
      await pruneExpiredRateLimits(db, at, rule.windowSeconds);
    }

    return {
      allowed: row.count <= rule.max,
      retryAfterSeconds: Math.max(1, Math.ceil((windowEndsAt - at.getTime()) / 1000)),
    };
  };

/**
 * 清掉已经不可能再拒绝任何请求的旧窗口。行数本来就只随「客户端 IP × 受限路径」增长
 * （同一个键靠 upsert 复用），这里只是防止长尾 IP 无限堆积。
 */
export const pruneExpiredRateLimits = async (
  db: Db,
  now: Date,
  windowSeconds: number,
): Promise<void> => {
  const cutoff = new Date(now.getTime() - windowSeconds * 1000);
  await db.delete(apiRateLimit).where(lt(apiRateLimit.windowStartedAt, cutoff));
};

export type RateLimitOptions = {
  limiter: RateLimiter;
  rule: RateLimitRule;
  /** 返回 true 的路径不限流（如健康检查——被限流会让编排系统误判实例不健康）。 */
  isExempt?: (path: string) => boolean;
};

/**
 * 按「客户端 IP + 路径」限流本服务自有端点。
 * better-auth 的限流只覆盖它自己的 `/api/auth/*`，`/api/me` 这类自有端点得由这里兜住。
 */
export const rateLimitMiddleware = ({ limiter, rule, isExempt }: RateLimitOptions) =>
  createMiddleware<ClientIpEnv>(async (c, next) => {
    const path = c.req.path;
    if (isExempt?.(path) === true) {
      await next();
      return;
    }

    const clientIp = c.get("clientIp") ?? UNKNOWN_CLIENT_IP;
    const decision = await limiter(`${clientIp}|${path}`, rule);

    if (!decision.allowed) {
      throw new AppError(429, "RATE_LIMITED", "too many requests", [], {
        "Retry-After": String(decision.retryAfterSeconds),
      });
    }

    await next();
  });
