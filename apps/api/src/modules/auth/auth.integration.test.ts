import { randomUUID } from "node:crypto";
import {
  apiErrorSchema,
  betterAuthErrorSchema,
  meResponseSchema,
} from "@agent-coordinator/contracts";
import { inArray } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { type AppDeps, createApp } from "../../app.js";
import { CLIENT_IP_HEADER } from "../../shared/client-ip.js";
import { createDb, createPool, type Db } from "../../shared/db.js";
import { type AppConfig, loadConfig } from "../../shared/env.js";
import { createRateLimiter } from "../../shared/rate-limit.js";
import { apiRateLimit } from "../../shared/rate-limit.schema.js";
import { createAuth } from "./auth.js";
import { rateLimit, user } from "./schema.js";

// 打真实 Postgres（compose.yaml 起的实例），不 mock 数据库。
// 每个测试自建自清数据：邮箱随机、结束删自己建的 user（session/account 级联删除）。

const config: AppConfig = loadConfig();
const pool: Pool = createPool(config.db);
const db: Db = createDb(pool);
const auth = createAuth(db, config.auth);
const rateLimiter = createRateLimiter(db);

// 默认放宽本服务的限流，让这些用例聚焦 better-auth 的行为；
// 限流本身在下面的 "rate limiting" 分组里用收紧的额度单独测。
const makeApp = (overrides: Partial<AppDeps> = {}) =>
  createApp({
    auth,
    rateLimiter,
    rateLimit: { windowSeconds: 60, max: 10_000 },
    allowedOrigins: config.auth.trustedOrigins,
    trustedProxies: [],
    maxBodyBytes: config.http.maxBodyBytes,
    ...overrides,
  });

const app = makeApp();

const PASSWORD = "correct-horse-battery-staple";
const createdEmails: string[] = [];

const freshEmail = (): string => {
  const email = `auth-test-${randomUUID()}@example.test`;
  createdEmails.push(email);
  return email;
};

const url = (path: string): string => `${config.auth.baseUrl}${path}`;

// 浏览器一定会带 Origin，better-auth 的 CSRF 检查也依赖它——测试照着真实调用方发。
const [browserOrigin = "http://localhost:3000"] = config.auth.trustedOrigins;

type RequestOptions = {
  cookie?: string;
  origin?: string;
  forwardedFor?: string;
  /** 客户端伪造的内部 IP 头——信任边界必须无条件覆盖掉它。 */
  forgedClientIp?: string;
};

const headersFor = (options: RequestOptions): Record<string, string> => ({
  Origin: options.origin ?? browserOrigin,
  ...(options.cookie === undefined ? {} : { Cookie: options.cookie }),
  ...(options.forwardedFor === undefined ? {} : { "X-Forwarded-For": options.forwardedFor }),
  ...(options.forgedClientIp === undefined ? {} : { [CLIENT_IP_HEADER]: options.forgedClientIp }),
});

const post = async (
  path: string,
  body: unknown,
  options: RequestOptions = {},
  target = app,
): Promise<Response> =>
  target.request(url(path), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headersFor(options) },
    body: JSON.stringify(body),
  });

const get = async (path: string, options: RequestOptions = {}, target = app): Promise<Response> =>
  target.request(url(path), { headers: headersFor(options) });

/** 把响应里的 Set-Cookie 折成可回发的 Cookie 头。 */
const cookieFrom = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0])
    .filter((entry): entry is string => entry !== undefined && entry.length > 0)
    .join("; ");

const signUp = async (email: string, password = PASSWORD): Promise<Response> =>
  post("/api/auth/sign-up/email", { name: "Test User", email, password });

const signIn = async (
  email: string,
  password: string,
  options: RequestOptions = {},
  target = app,
): Promise<Response> => post("/api/auth/sign-in/email", { email, password }, options, target);

beforeEach(async () => {
  // 两套限流计数都是跨测试的共享状态，清掉才可重复
  await db.delete(rateLimit);
  await db.delete(apiRateLimit);
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

    const res = await get("/api/me", { cookie });
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

    const me = await get("/api/me", { cookie: cookieFrom(res) });
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
    expect((await get("/api/me", { cookie })).status).toBe(200);

    const out = await post("/api/auth/sign-out", {}, { cookie });
    expect(out.status).toBe(200);

    const after = await get("/api/me", { cookie });
    expect(after.status).toBe(401);
    expect(apiErrorSchema.parse(await after.json()).error.code).toBe("UNAUTHENTICATED");
  });

  it("duplicate_email_sign_up_is_rejected_and_creates_no_second_user", async () => {
    const email = freshEmail();
    expect((await signUp(email)).status).toBe(200);

    const res = await signUp(email);
    expect(res.status).toBe(422);
    expect(betterAuthErrorSchema.parse(await res.json()).code).toBe(
      "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
    );

    const rows = await db
      .select()
      .from(user)
      .where(inArray(user.email, [email]));
    expect(rows).toHaveLength(1);
  });

  it("sign_up_one_character_below_the_minimum_password_length_is_rejected", async () => {
    const email = freshEmail();
    // 11 位：正好是 minPasswordLength(12) - 1
    const res = await signUp(email, "elevenchars");

    expect(res.status).toBe(400);
    expect(betterAuthErrorSchema.parse(await res.json()).code).toBe("PASSWORD_TOO_SHORT");
    expect(
      await db
        .select()
        .from(user)
        .where(inArray(user.email, [email])),
    ).toHaveLength(0);
  });

  it("sign_up_at_exactly_the_minimum_password_length_is_accepted", async () => {
    const email = freshEmail();
    // 12 位：正好等于 minPasswordLength，边界的另一侧
    expect((await signUp(email, "twelvechars!")).status).toBe(200);
    expect(
      await db
        .select()
        .from(user)
        .where(inArray(user.email, [email])),
    ).toHaveLength(1);
  });
});

describe("cross-origin protection", () => {
  it("rejects_a_state_changing_request_from_an_untrusted_origin", async () => {
    // better-auth 在 NODE_ENV=test 下默认整体关掉 origin 校验；配置里显式
    // disableOriginCheck:false 之后测试才跑在与生产同一条分支上。
    const email = freshEmail();
    const res = await post(
      "/api/auth/sign-up/email",
      { name: "Evil", email, password: PASSWORD },
      { origin: "http://evil.example.com" },
    );

    expect(res.status).toBe(403);
    expect(betterAuthErrorSchema.parse(await res.json()).code).toBe("INVALID_ORIGIN");
    expect(
      await db
        .select()
        .from(user)
        .where(inArray(user.email, [email])),
    ).toHaveLength(0);
  });

  it("still_accepts_the_same_request_from_a_trusted_origin", async () => {
    expect((await signUp(freshEmail())).status).toBe(200);
  });
});

describe("rate limiting", () => {
  // 配置了可信代理，客户端 IP 从 X-Forwarded-For 链上解析出来
  const behindProxy = makeApp({ trustedProxies: ["10.0.0.0/8"] });
  const asClient = (ip: string): RequestOptions => ({ forwardedFor: `${ip}, 10.0.0.1` });

  it("one_client_exhausting_the_sign_in_budget_does_not_lock_out_other_clients", async () => {
    const email = freshEmail();
    await signUp(email);
    await db.delete(rateLimit);

    const attacker: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      attacker.push(
        (await signIn(email, "wrong-password", asClient("203.0.113.7"), behindProxy)).status,
      );
    }
    expect(attacker).toContain(429);

    // 另一个客户端不受影响——这正是"全局共享桶"退化时会挂掉的断言
    const bystander = await signIn(email, "wrong-password", asClient("198.51.100.4"), behindProxy);
    expect(bystander.status).toBe(401);
  });

  it("cannot_escape_the_auth_rate_limit_by_forging_the_internal_client_ip_header", async () => {
    // 信任边界那一行（无条件覆盖内部头）是整套分桶的地基。攻击者每次换一个伪造值，
    // 如果它没被覆盖，better-auth 会给每个伪造值单开一个桶，暴力破解限流就完全失效。
    const email = freshEmail();
    await signUp(email);
    await db.delete(rateLimit);

    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push(
        (
          await signIn(
            email,
            "wrong-password",
            { ...asClient("203.0.113.50"), forgedClientIp: `198.51.100.${i + 1}` },
            behindProxy,
          )
        ).status,
      );
    }

    expect(statuses).toContain(429);

    // better-auth 侧只应该看到一个桶——伪造值一个都不该变成桶
    const signInBuckets = (await db.select().from(rateLimit))
      .map((row) => row.key)
      .filter((key) => key.endsWith("/sign-in/email"));
    expect(signInBuckets).toEqual(["203.0.113.50|/sign-in/email"]);
  });

  it("keeps_the_auth_rate_limit_counters_in_the_database", async () => {
    await signIn(freshEmail(), "wrong-password", asClient("203.0.113.9"), behindProxy);
    const rows = await db.select().from(rateLimit);
    expect(rows.map((row) => row.key)).toContain("203.0.113.9|/sign-in/email");
  });

  it("rate_limits_our_own_endpoints_too_not_just_the_auth_routes", async () => {
    const tight = makeApp({
      trustedProxies: ["10.0.0.0/8"],
      rateLimit: { windowSeconds: 60, max: 3 },
    });

    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push((await get("/api/me", asClient("203.0.113.20"), tight)).status);
    }

    expect(statuses).toEqual([401, 401, 401, 429, 429]);
    const last = await get("/api/me", asClient("203.0.113.20"), tight);
    expect(last.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(apiErrorSchema.parse(await last.json()).error.code).toBe("RATE_LIMITED");
  });

  it("gives_each_client_its_own_budget_on_our_own_endpoints", async () => {
    const tight = makeApp({
      trustedProxies: ["10.0.0.0/8"],
      rateLimit: { windowSeconds: 60, max: 2 },
    });

    for (let i = 0; i < 3; i += 1) {
      await get("/api/me", asClient("203.0.113.31"), tight);
    }
    expect((await get("/api/me", asClient("203.0.113.31"), tight)).status).toBe(429);
    expect((await get("/api/me", asClient("198.51.100.32"), tight)).status).toBe(401);
  });
});
