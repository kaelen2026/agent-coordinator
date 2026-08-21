import { randomUUID } from "node:crypto";
import { apiErrorSchema, meResponseSchema } from "@agent-coordinator/contracts";
import { inArray } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../../app.js";
import { createDb, createPool, type Db } from "../../shared/db.js";
import { type AppConfig, loadConfig } from "../../shared/env.js";
import { createAuth } from "./auth.js";
import { rateLimit, user } from "./schema.js";

// 打真实 Postgres（compose.yaml 起的实例），不 mock 数据库。
// 每个测试自建自清数据：邮箱随机、结束删自己建的 user（session/account 级联删除）。

const config: AppConfig = loadConfig();
const pool: Pool = createPool(config.db);
const db: Db = createDb(pool);
const app = createApp({
  auth: createAuth(db, config.auth),
  allowedOrigins: config.auth.trustedOrigins,
  maxBodyBytes: config.http.maxBodyBytes,
});

const PASSWORD = "correct-horse-battery-staple";
const createdEmails: string[] = [];

const freshEmail = (): string => {
  const email = `auth-test-${randomUUID()}@example.test`;
  createdEmails.push(email);
  return email;
};

const url = (path: string): string => `${config.auth.baseUrl}${path}`;

// 浏览器一定会带 Origin，better-auth 的 CSRF 检查也依赖它——测试照着真实调用方发，
// 否则像 sign-out 这种要求 Origin 的端点在测试里走的是另一条分支。
const [browserOrigin] = config.auth.trustedOrigins;

const post = async (path: string, body: unknown, cookie?: string): Promise<Response> =>
  app.request(url(path), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(browserOrigin === undefined ? {} : { Origin: browserOrigin }),
      ...(cookie === undefined ? {} : { Cookie: cookie }),
    },
    body: JSON.stringify(body),
  });

const get = async (path: string, cookie?: string): Promise<Response> =>
  app.request(url(path), {
    headers: {
      ...(browserOrigin === undefined ? {} : { Origin: browserOrigin }),
      ...(cookie === undefined ? {} : { Cookie: cookie }),
    },
  });

/** 把响应里的 Set-Cookie 折成可回发的 Cookie 头。 */
const cookieFrom = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0])
    .filter((entry): entry is string => entry !== undefined && entry.length > 0)
    .join("; ");

const signUp = async (email: string, password = PASSWORD): Promise<Response> =>
  post("/api/auth/sign-up/email", { name: "Test User", email, password });

const signIn = async (email: string, password: string): Promise<Response> =>
  post("/api/auth/sign-in/email", { email, password });

beforeEach(async () => {
  // 限流计数是跨测试的共享状态（同一个 IP + path 桶），清掉才可重复
  await db.delete(rateLimit);
});

afterEach(async () => {
  if (createdEmails.length > 0) {
    await db.delete(user).where(inArray(user.email, createdEmails));
    createdEmails.length = 0;
  }
});

afterAll(async () => {
  await pool.end();
});

describe("email + password auth", () => {
  it("sign_up_establishes_a_session_cookie", async () => {
    const res = await signUp(freshEmail());

    expect(res.status).toBe(200);
    expect(cookieFrom(res)).toMatch(/better-auth\.session_token=/);
  });

  it("me_returns_contract_shaped_whitelisted_user_for_a_signed_up_session", async () => {
    const email = freshEmail();
    const cookie = cookieFrom(await signUp(email));

    const res = await get("/api/me", cookie);
    expect(res.status).toBe(200);

    const body: unknown = await res.json();
    const parsed = meResponseSchema.parse(body);
    expect(parsed.user.email).toBe(email);
    expect(parsed.user.name).toBe("Test User");
    expect(parsed.user.emailVerified).toBe(false);
    expect(parsed.user.image).toBeNull();

    // 白名单断言必须打在原始响应上：meResponseSchema.parse 会剥掉多余字段，
    // 拿 parse 后的结果断言就永远看不到泄漏。
    const rawUser = z.object({ user: z.record(z.unknown()) }).parse(body).user;
    expect(Object.keys(rawUser).sort()).toEqual([
      "createdAt",
      "email",
      "emailVerified",
      "id",
      "image",
      "name",
    ]);
    expect(JSON.stringify(body)).not.toMatch(/password|hash|salt/i);
  });

  it("me_without_a_cookie_is_unauthenticated", async () => {
    const res = await get("/api/me");
    expect(res.status).toBe(401);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe("UNAUTHENTICATED");
  });

  it("sign_in_with_the_right_password_establishes_a_session", async () => {
    const email = freshEmail();
    await signUp(email);

    const res = await signIn(email, PASSWORD);
    expect(res.status).toBe(200);

    const me = await get("/api/me", cookieFrom(res));
    expect(me.status).toBe(200);
    expect(meResponseSchema.parse(await me.json()).user.email).toBe(email);
  });

  it("sign_in_failure_does_not_reveal_whether_the_account_exists", async () => {
    const existing = freshEmail();
    await signUp(existing);

    const wrongPassword = await signIn(existing, "definitely-not-the-password");
    const unknownAccount = await signIn(`auth-test-${randomUUID()}@example.test`, PASSWORD);

    expect(wrongPassword.status).toBe(401);
    expect(unknownAccount.status).toBe(wrongPassword.status);
    expect(await unknownAccount.text()).toBe(await wrongPassword.text());
    expect(cookieFrom(wrongPassword)).not.toMatch(/session_token=[^;\s]/);
  });

  it("sign_out_invalidates_the_previous_session_cookie", async () => {
    const cookie = cookieFrom(await signUp(freshEmail()));
    expect((await get("/api/me", cookie)).status).toBe(200);

    const out = await post("/api/auth/sign-out", {}, cookie);
    expect(out.status).toBe(200);

    const after = await get("/api/me", cookie);
    expect(after.status).toBe(401);
    expect(apiErrorSchema.parse(await after.json()).error.code).toBe("UNAUTHENTICATED");
  });

  it("duplicate_email_sign_up_is_rejected_and_creates_no_second_user", async () => {
    const email = freshEmail();
    expect((await signUp(email)).status).toBe(200);

    const res = await signUp(email);
    expect(res.status).toBeGreaterThanOrEqual(400);

    const rows = await db
      .select()
      .from(user)
      .where(inArray(user.email, [email]));
    expect(rows).toHaveLength(1);
  });

  it("sign_up_below_the_minimum_password_length_is_rejected", async () => {
    const email = freshEmail();
    // 11 位：刚好低于 minPasswordLength = 12
    const res = await signUp(email, "elevenchar");

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(
      await db
        .select()
        .from(user)
        .where(inArray(user.email, [email])),
    ).toHaveLength(0);
  });

  it("repeated_failed_sign_in_is_rate_limited_with_counters_kept_in_the_database", async () => {
    const email = freshEmail();
    await signUp(email);
    await db.delete(rateLimit);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      statuses.push((await signIn(email, "definitely-not-the-password")).status);
    }

    expect(statuses).toContain(429);
    // 限流状态必须落库（进程无状态、可水平扩展），不是进程内存
    expect(await db.select().from(rateLimit)).not.toHaveLength(0);
  });
});
