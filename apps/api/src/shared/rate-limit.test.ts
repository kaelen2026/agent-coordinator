import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, createPool, type Db } from "./db.js";
import { loadConfig } from "./env.js";
import { createRateLimiter, pruneExpiredRateLimits } from "./rate-limit.js";
import { apiRateLimit } from "./rate-limit.schema.js";

const config = loadConfig();
// 并发用例要真的并发：连接池小于并发度时 Promise.all 会在池上排队，
// 测试会静默退化成"顺序调用 N 次"，再也抓不到 read-modify-write。
const CONCURRENCY = 12;
const pool: Pool = createPool({ ...config.db, poolMax: Math.max(config.db.poolMax, CONCURRENCY) });
const db: Db = createDb(pool);

const RULE = { windowSeconds: 60, max: 3 };

// 注入时钟：窗口过期靠推进假时钟验证，不 sleep 等真实时间
let clock = new Date("2026-03-01T00:00:00.000Z");
const now = (): Date => clock;
const advanceSeconds = (seconds: number): void => {
  clock = new Date(clock.getTime() + seconds * 1000);
};

// 清理默认按时间节流；这些用例要的是可预测的限流判定，所以把自动清理关掉
// （pruneEveryMs 给一个跑不到的值），清理本身单独测。
const limiter = createRateLimiter(db, { now, pruneEveryMs: Number.MAX_SAFE_INTEGER });

beforeEach(async () => {
  clock = new Date("2026-03-01T00:00:00.000Z");
  await db.delete(apiRateLimit);
});

afterAll(async () => {
  await pool.end();
});

describe("createRateLimiter", () => {
  it("allows_exactly_the_budget_then_denies", async () => {
    const decisions = [];
    for (let i = 0; i < 5; i += 1) {
      decisions.push(await limiter("client-a|/api/me", RULE));
    }
    expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, false, false]);
  });

  it("keeps_separate_budgets_per_key_so_one_client_cannot_lock_out_another", async () => {
    for (let i = 0; i < 3; i += 1) {
      await limiter("client-a|/api/me", RULE);
    }
    expect((await limiter("client-a|/api/me", RULE)).allowed).toBe(false);
    expect((await limiter("client-b|/api/me", RULE)).allowed).toBe(true);
  });

  it("keeps_separate_budgets_per_path", async () => {
    for (let i = 0; i < 3; i += 1) {
      await limiter("client-a|/api/me", RULE);
    }
    expect((await limiter("client-a|/api/me", RULE)).allowed).toBe(false);
    expect((await limiter("client-a|/healthz", RULE)).allowed).toBe(true);
  });

  it("reports_how_long_to_wait_when_denied", async () => {
    for (let i = 0; i < 3; i += 1) {
      await limiter("client-a|/api/me", RULE);
    }
    advanceSeconds(20);
    const denied = await limiter("client-a|/api/me", RULE);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(40);
  });

  it("starts_a_fresh_budget_once_the_window_has_passed", async () => {
    for (let i = 0; i < 4; i += 1) {
      await limiter("client-a|/api/me", RULE);
    }
    expect((await limiter("client-a|/api/me", RULE)).allowed).toBe(false);

    advanceSeconds(RULE.windowSeconds + 1);
    expect((await limiter("client-a|/api/me", RULE)).allowed).toBe(true);
  });

  it("counts_concurrent_requests_exactly_once_each", async () => {
    // 并发打同一个桶：read-modify-write 实现会让多个请求读到同一个旧值一起放行
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => limiter("client-burst|/api/me", RULE)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(RULE.max);
  });

  it("keeps_the_counter_in_the_database_not_in_the_process", async () => {
    await limiter("client-a|/api/me", RULE);
    const rows = await db.select().from(apiRateLimit);
    expect(rows).toEqual([expect.objectContaining({ key: "client-a|/api/me", count: 1 })]);
  });
});

describe("pruneExpiredRateLimits", () => {
  it("removes_windows_that_can_no_longer_deny_anything", async () => {
    await limiter("stale|/api/me", RULE);
    advanceSeconds(RULE.windowSeconds * 2);
    await limiter("fresh|/api/me", RULE);

    await pruneExpiredRateLimits(db, now(), RULE.windowSeconds);

    const rows = await db.select().from(apiRateLimit);
    expect(rows.map((row) => row.key)).toEqual(["fresh|/api/me"]);
  });

  it("keeps_buckets_that_a_longer_window_rule_still_needs", async () => {
    // 保留时长必须与"当前这条规则的窗口"解耦：否则短窗口那次请求的清理
    // 会把长窗口尚未过期的桶删掉，等于静默放行
    await limiter("slow-rule|/api/me", { windowSeconds: 3600, max: 3 });
    advanceSeconds(120);

    await pruneExpiredRateLimits(db, now(), 24 * 60 * 60);

    expect(await db.select().from(apiRateLimit)).toHaveLength(1);
  });
});

describe("automatic pruning", () => {
  const staleKey = "long-gone|/api/me";

  /** 直接塞一行"早已过期、任何窗口都用不上"的记录，用它观察清理有没有真的跑。 */
  const insertStaleRow = async (): Promise<void> => {
    await db.insert(apiRateLimit).values({
      key: staleKey,
      count: 1,
      windowStartedAt: new Date(now().getTime() - 25 * 60 * 60 * 1000),
    });
  };

  const staleRowStillThere = async (): Promise<boolean> =>
    (await db.select().from(apiRateLimit)).some((row) => row.key === staleKey);

  it("does_not_prune_once_per_new_key", async () => {
    // 之前挂在 count===1 上：每个新键的首个请求都满足它，未匹配路径洪水下
    // 就变成"每个请求一次全表 DELETE"，是放大器而不是缓解
    const throttled = createRateLimiter(db, { now, pruneEveryMs: 60_000 });
    await throttled("warmup|/api/me", RULE);

    await insertStaleRow();
    for (let i = 0; i < 10; i += 1) {
      await throttled(`flood-${i}|/api/me`, RULE);
    }

    expect(await staleRowStillThere()).toBe(true);
  });

  it("prunes_again_once_the_interval_has_elapsed", async () => {
    const throttled = createRateLimiter(db, { now, pruneEveryMs: 60_000 });
    await throttled("warmup|/api/me", RULE);
    await insertStaleRow();

    advanceSeconds(61);
    await throttled("after-interval|/api/me", RULE);

    expect(await staleRowStillThere()).toBe(false);
  });
});
