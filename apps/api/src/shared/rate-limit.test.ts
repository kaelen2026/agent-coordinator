import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, createPool, type Db } from "./db.js";
import { loadConfig } from "./env.js";
import { createRateLimiter, pruneExpiredRateLimits } from "./rate-limit.js";
import { apiRateLimit } from "./rate-limit.schema.js";

const config = loadConfig();
const pool: Pool = createPool(config.db);
const db: Db = createDb(pool);

const RULE = { windowSeconds: 60, max: 3 };

// 注入时钟：窗口过期靠推进假时钟验证，不 sleep 等真实时间
let clock = new Date("2026-03-01T00:00:00.000Z");
const now = (): Date => clock;
const advanceSeconds = (seconds: number): void => {
  clock = new Date(clock.getTime() + seconds * 1000);
};

const limiter = createRateLimiter(db, now);

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
      Array.from({ length: 12 }, () => limiter("client-burst|/api/me", RULE)),
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
});
