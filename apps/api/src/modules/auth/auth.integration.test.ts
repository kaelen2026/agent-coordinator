import { randomUUID } from "node:crypto";
import {
  apiErrorSchema,
  bearerAuthorization,
  betterAuthErrorSchema,
  meResponseSchema,
  SESSION_TOKEN_HEADER,
} from "@agent-coordinator/contracts";
import { type ServerType, serve } from "@hono/node-server";
import { eq, inArray, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type AppDeps, createApp } from "../../app.js";
import { CLIENT_IP_HEADER } from "../../shared/client-ip.js";
import { createDb, createPool, type Db } from "../../shared/db.js";
import { type AppConfig, loadConfig } from "../../shared/env.js";
import { installConsoleRedaction } from "../../shared/log-redaction.js";
import { createRateLimiter } from "../../shared/rate-limit.js";
import { apiRateLimit } from "../../shared/rate-limit.schema.js";
import { createAuth } from "./auth.js";
import { account, rateLimit, session, user } from "./schema.js";

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

// better-auth 总是把 baseURL 的源放进 trustedOrigins，所以这个值不用配也一定被信任——
// 原生客户端（iOS）照它发 Origin。
const apiOrigin = new URL(config.auth.baseUrl).origin;

type RequestOptions = {
  cookie?: string;
  /** `null` = 一个 Origin 头都不发（原生 URLSession 的默认行为）。 */
  origin?: string | null;
  /** 会话 token，按 `Authorization: Bearer <token>` 发出。 */
  bearer?: string;
  forwardedFor?: string;
  /** 客户端伪造的内部 IP 头——信任边界必须无条件覆盖掉它。 */
  forgedClientIp?: string;
};

const headersFor = (options: RequestOptions): Record<string, string> => {
  const origin = options.origin === undefined ? browserOrigin : options.origin;
  return {
    ...(origin === null ? {} : { Origin: origin }),
    ...(options.bearer === undefined ? {} : { Authorization: bearerAuthorization(options.bearer) }),
    ...(options.cookie === undefined ? {} : { Cookie: options.cookie }),
    ...(options.forwardedFor === undefined ? {} : { "X-Forwarded-For": options.forwardedFor }),
    ...(options.forgedClientIp === undefined ? {} : { [CLIENT_IP_HEADER]: options.forgedClientIp }),
  };
};

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

/** bearer plugin 把会话 token 放在这个响应头里，原生客户端从这里取。头名取自契约。 */
const tokenFrom = (res: Response): string => res.headers.get(SESSION_TOKEN_HEADER) ?? "";

/**
 * `set-auth-token` 的形状：`<会话 id>.<HMAC 签名>`，签名是**标准** base64
 * （会出现 `+` `/` 和末尾的 `=` 填充）。契约里写死了它，因为客户端必须原样透传。
 *
 * 「加工过的 token 会怎样」只写实测到的这两条，其余不猜：
 *   - 按 `.` 截断、只留裸的会话 id → 401，由
 *     `rejects_a_bare_session_id_that_carries_no_signature` 钉住；
 *   - 百分号编码 → 服务端当前会容忍（200），由
 *     `currently_tolerates_a_percent_encoded_token_but_the_contract_still_says_pass_it_through`
 *     钉住；那是观测到的宽容度、不是承诺，客户端仍必须原样透传。
 *
 * 契约还禁止 trim 等其它加工，但那是"不做没理由做的事"，本仓库没有实测其后果——
 * 别把禁令读成"这么干一定会 401"。
 */
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9+/]{16,}={0,2}$/;

const signUp = async (
  email: string,
  password = PASSWORD,
  options: RequestOptions = {},
): Promise<Response> =>
  post("/api/auth/sign-up/email", { name: "Test User", email, password }, options);

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

  it("rejects_a_credentialed_request_that_carries_no_origin_at_all", async () => {
    // 浏览器一定会带 Origin，但 Next.js 的 Server Action / 服务端 fetch 默认不带——
    // 切片 2 从服务端转发登出会直接吃这个 403，契约表里必须有它。
    const cookie = cookieFrom(await signUp(freshEmail()));
    const res = await app.request(url("/api/auth/sign-out"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: "{}",
    });

    expect(res.status).toBe(403);
    expect(betterAuthErrorSchema.parse(await res.json()).code).toBe("MISSING_OR_NULL_ORIGIN");
  });
});

// 原生客户端（iOS URLSession）：不带 cookie；Origin 发 api 自己的源。
const NATIVE: RequestOptions = { origin: apiOrigin };

describe("bearer token auth for native clients", () => {
  it("sign_up_hands_the_native_client_a_session_token_in_a_response_header", async () => {
    const res = await signUp(freshEmail(), PASSWORD, NATIVE);

    expect(res.status).toBe(200);
    expect(tokenFrom(res)).not.toBe("");
  });

  it("hands_out_a_signed_token_shaped_the_way_the_contract_promises", async () => {
    // iOS 按这个形状存 Keychain 并原样发回；形状变了客户端解析假设就得跟着改，
    // 而客户端不可热修——所以钉在测试里，better-auth 升级动了它必须先红。
    const token = tokenFrom(await signUp(freshEmail(), PASSWORD, NATIVE));

    expect(token).toMatch(TOKEN_FORMAT);
  });

  it("currently_tolerates_a_percent_encoded_token_but_the_contract_still_says_pass_it_through", async () => {
    // 钉住的是**当前观测到的宽容行为，不是我们承诺的契约**——契约要求客户端原样透传 token。
    // 之所以要钉：这是个"错了也不报错"的坑（bearer 被翻译成 cookie 后走 cookie 解析，
    // 顺手把百分号编码解掉了），iOS 若误加 encodeURIComponent，开发期一切正常。客户端不可热修，
    // 等 better-auth 收紧这个宽容度就是全量登出。有这条测试，收紧时 CI 先红。
    const email = freshEmail();
    const token = tokenFrom(await signUp(email, PASSWORD, NATIVE));
    const encoded = encodeURIComponent(token);
    // 先确认这次真编码掉了东西（签名是标准 base64，`+` `/` `=` 都会被转义）——
    // 否则下面的 200 只是把原样 token 又发了一遍，属于假绿。
    expect(encoded).not.toBe(token);
    expect(encoded).toContain("%");

    const res = await get("/api/me", { ...NATIVE, bearer: encoded });

    expect(res.status).toBe(200);
    expect(meResponseSchema.parse(await res.json()).user.email).toBe(email);
  });

  it("sign_in_hands_the_native_client_a_session_token_in_a_response_header", async () => {
    const email = freshEmail();
    await signUp(email, PASSWORD, NATIVE);

    const res = await signIn(email, PASSWORD, NATIVE);

    expect(res.status).toBe(200);
    expect(tokenFrom(res)).not.toBe("");
  });

  it("me_returns_the_same_whitelisted_user_for_a_bearer_token_as_for_a_cookie", async () => {
    const email = freshEmail();
    const signedUp = await signUp(email, PASSWORD, NATIVE);

    const viaBearer = await get("/api/me", { ...NATIVE, bearer: tokenFrom(signedUp) });
    expect(viaBearer.status).toBe(200);

    const viaCookie = await get("/api/me", { cookie: cookieFrom(signedUp) });
    expect(viaCookie.status).toBe(200);

    // 两条路径必须给出完全相同的响应体——白名单不能因为凭证形态而多一个字段
    expect(await viaBearer.json()).toEqual(await viaCookie.json());
  });

  it("sign_out_with_a_bearer_token_revokes_that_token", async () => {
    const token = tokenFrom(await signUp(freshEmail(), PASSWORD, NATIVE));
    expect((await get("/api/me", { ...NATIVE, bearer: token })).status).toBe(200);

    const out = await post("/api/auth/sign-out", {}, { ...NATIVE, bearer: token });
    expect(out.status).toBe(200);

    const after = await get("/api/me", { ...NATIVE, bearer: token });
    expect(after.status).toBe(401);
    expect(apiErrorSchema.parse(await after.json()).error.code).toBe("UNAUTHENTICATED");
  });
});

describe("bearer token rejection", () => {
  /** 拿到一个签名合法、但对应会话已经不在库里的 token（等价于被吊销 / 过期后清理）。 */
  const orphanedToken = async (): Promise<string> => {
    const email = freshEmail();
    const token = tokenFrom(await signUp(email, PASSWORD, NATIVE));
    const [owner] = await db.select().from(user).where(eq(user.email, email));
    await db.delete(session).where(eq(session.userId, owner?.id ?? ""));
    return token;
  };

  it("rejects_a_bare_session_id_that_carries_no_signature", async () => {
    // bearer plugin 默认（requireSignature: false）会**自己给没签名的 token 补上签名**，
    // 于是光有会话 id 就能认证——数据库读权限、一行日志、一次备份泄漏都足以冒充用户。
    // 我们只发签名过的 token，所以要求签名不损失任何功能。
    const email = freshEmail();
    await signUp(email, PASSWORD, NATIVE);
    const [owner] = await db.select().from(user).where(eq(user.email, email));
    const [row] = await db
      .select()
      .from(session)
      .where(eq(session.userId, owner?.id ?? ""));
    const bareId = row?.token ?? "";
    // 先确认真拿到了 id，否则下面的 401 是因为发了空串而假绿
    expect(bareId).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(bareId).not.toContain(".");

    const res = await get("/api/me", { ...NATIVE, bearer: bareId });

    expect(res.status).toBe(401);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects_a_bearer_token_whose_signature_has_been_tampered_with", async () => {
    const token = tokenFrom(await signUp(freshEmail(), PASSWORD, NATIVE));
    const [id = "", signature = ""] = token.split(".");
    expect(signature.length).toBeGreaterThan(8);
    // 只动签名的最后一个字符：id 仍然指向一条真实会话，唯一失效的是 HMAC
    const flipped = `${signature.slice(0, -1)}${signature.at(-1) === "A" ? "B" : "A"}`;

    const res = await get("/api/me", { ...NATIVE, bearer: `${id}.${flipped}` });

    expect(res.status).toBe(401);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects_a_correctly_signed_token_whose_session_no_longer_exists", async () => {
    const res = await get("/api/me", { ...NATIVE, bearer: await orphanedToken() });

    expect(res.status).toBe(401);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects_a_bearer_token_whose_session_has_expired", async () => {
    const email = freshEmail();
    const token = tokenFrom(await signUp(email, PASSWORD, NATIVE));
    const [owner] = await db.select().from(user).where(eq(user.email, email));
    const expired = await db
      .update(session)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(session.userId, owner?.id ?? ""))
      .returning();
    // 确认真的改到了行，否则这个测试测的是"会话还有效"
    expect(expired).toHaveLength(1);

    const res = await get("/api/me", { ...NATIVE, bearer: token });

    expect(res.status).toBe(401);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe("UNAUTHENTICATED");
  });

  it("treats_sign_out_with_an_already_dead_token_as_success", async () => {
    // iOS 的登出按钮完全可能在 token 已经失效之后才被按下（会话过期、别处登出过）。
    // 实测 better-auth 在这里是幂等的：照样 200，不报错——契约里必须写清，否则客户端
    // 会给用户弹一个毫无意义的"登出失败"。
    const dead = await orphanedToken();

    const res = await post("/api/auth/sign-out", {}, { ...NATIVE, bearer: dead });

    expect(res.status).toBe(200);
    // 也不会顺手再发一个 token 回来
    expect(tokenFrom(res)).toBe("");
  });

  it("answers_every_malformed_credential_exactly_like_a_missing_one", async () => {
    // 401 的响应不许透露"token 格式不对"/"签名错"/"会话没了"的差别（security.md），
    // 也不许回显 token 本身或任何内部细节。
    const orphaned = await orphanedToken();
    const baseline = await get("/api/me", NATIVE);
    const baselineBody = await baseline.text();

    for (const token of ["", "   ", "not-a-token", "a.b", `${orphaned}extra`, orphaned]) {
      const res = await get("/api/me", { ...NATIVE, bearer: token });
      // 把 token 拼进断言的两侧，失败时能直接看出是哪个变体崩的
      const label = `token=${JSON.stringify(token)}`;
      expect(`${label} status=${res.status}`).toBe(`${label} status=${baseline.status}`);
      expect(`${label} body=${await res.text()}`).toBe(`${label} body=${baselineBody}`);
    }
    expect(baseline.status).toBe(401);
    expect(baselineBody).not.toMatch(/session|cookie|hmac|signature|better-auth/i);
  });
});

describe("origin requirements for native clients", () => {
  // 原生 URLSession 默认一个 Origin 头都不发。better-auth 的 origin/CSRF 校验只在请求
  // **带 Cookie 头**时才强制（origin-check.mjs 的 `useCookies`），或者在请求已经带了
  // Origin/Referer/Sec-Fetch-* 时强制（sign-in/sign-up 的 formCsrfMiddleware）。
  // 这是 iOS 契约的地基：契约里那张 3×3 的 Origin 矩阵，本块逐格钉住（"不发 Origin" 与
  // "不可信 Origin" 两行，共 6 格；"api 自己的源"那一行由上面 bearer 各测试用 NATIVE 覆盖）——
  // 升级 better-auth 时任何一格变了必须让 CI 先红，而不是等 iOS 上线挂掉。
  //
  // 本块另有三条**不属于那 9 格**的测试，钉的是矩阵头两行各自的前提（即"客户端一个
  // `Sec-Fetch-*` 都不发"），契约第 5 节那两条警告靠它们成立：
  //   - `rejects_sign_in_that_sends_sec_fetch_headers_but_no_origin`
  //     ——补了 `Sec-Fetch-*` 却不发 Origin，第一行的 200 就变 403；
  //   - `node_fetch_without_an_origin_is_rejected_because_its_own_stack_adds_sec_fetch_mode`
  //     ——上面那个头调用方的 HTTP 栈会**自己**补上，不需要谁手写；
  //   - `blocks_cross_site_navigation_sign_in_even_when_the_origin_is_trusted`
  //     ——跨站导航形态在校验 Origin 之前就被拦，第二行的"发可信 Origin 就 200"也有前提。
  const noOrigin: RequestOptions = { origin: null };

  it("accepts_sign_up_from_a_client_that_sends_no_origin_and_no_cookie", async () => {
    const res = await signUp(freshEmail(), PASSWORD, noOrigin);

    expect(res.status).toBe(200);
    expect(tokenFrom(res)).not.toBe("");
  });

  it("accepts_sign_in_from_a_client_that_sends_no_origin_and_no_cookie", async () => {
    const email = freshEmail();
    await signUp(email, PASSWORD, noOrigin);

    const res = await signIn(email, PASSWORD, noOrigin);

    expect(res.status).toBe(200);
    expect(tokenFrom(res)).not.toBe("");
  });

  it("rejects_sign_in_that_sends_sec_fetch_headers_but_no_origin", async () => {
    // 契约 Origin 矩阵第一行（"不发 Origin → 200"）只在**一个 `Sec-Fetch-*` 都不发**时成立：
    // better-auth 的 formCsrfMiddleware 把 `Sec-Fetch-*` 也当成"这是浏览器发的"信号，于是
    // 强制要求 Origin，缺了就 403 MISSING_OR_NULL_ORIGIN。
    // 这一格必须有测试：Node/undici 的内置 fetch **默认就补 `sec-fetch-mode`**，拿它写的
    // 集成脚本会全量吃 403 却看不出原因（那一侧由下面那条真 HTTP 的测试钉）。URLSession 不发
    // `Sec-Fetch-*`，所以矩阵第一行对 iOS 仍然成立——但 better-auth 一旦把这个触发条件放宽到
    // "任何请求"，这条会先红。
    const email = freshEmail();
    await signUp(email, PASSWORD, noOrigin);

    const res = await app.request(url("/api/auth/sign-in/email"), {
      method: "POST",
      // 刻意只有 Sec-Fetch-Mode、没有 Origin / Referer / Cookie
      headers: { "Content-Type": "application/json", "Sec-Fetch-Mode": "cors" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });

    expect(res.status).toBe(403);
    expect(betterAuthErrorSchema.parse(await res.json()).code).toBe("MISSING_OR_NULL_ORIGIN");
    // 对照：同一个请求去掉 Sec-Fetch-Mode 就是 200。少了这一句，上面的 403 也可能是别的原因。
    expect((await signIn(email, PASSWORD, noOrigin)).status).toBe(200);
  });

  it("node_fetch_without_an_origin_is_rejected_because_its_own_stack_adds_sec_fetch_mode", async () => {
    // 契约第 5 节写了"Node/undici 的内置 fetch 默认就补 `sec-fetch-mode: cors`"。那是**别人家的
    // 行为**，上面那条手工塞头的测试证明不了它——手工塞头只说明"塞了就 403"，不说明"你什么都不做
    // 也会被塞"。而契约靠后半句才成立（qa 的集成脚本就是这么全量 403 的）。
    // 所以这里走真 HTTP + 全局 fetch：不写任何 Origin / Sec-Fetch-* 头，照样 403。
    // undici 哪天不再补这个头、或 better-auth 不再把它当浏览器信号，这条先红，契约那句话就得改。
    const email = freshEmail();
    await signUp(email, PASSWORD, noOrigin);

    const { server, port } = await new Promise<{ server: ServerType; port: number }>((resolve) => {
      const started: ServerType = serve(
        { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
        (info) => resolve({ server: started, port: info.port }),
      );
    });

    try {
      const endpoint = `http://127.0.0.1:${port}/api/auth/sign-in/email`;
      const body = JSON.stringify({ email, password: PASSWORD });
      // 只设 Content-Type：Origin / Referer / Sec-Fetch-* 一个都没写
      const headers = { "Content-Type": "application/json" };

      const res = await fetch(endpoint, { method: "POST", headers, body });

      expect(res.status).toBe(403);
      expect(betterAuthErrorSchema.parse(await res.json()).code).toBe("MISSING_OR_NULL_ORIGIN");

      // 对照：同一条真 HTTP 请求补上可信 Origin 就是 200。少了它，上面的 403 也可能是
      // "真 HTTP 这条路本身就不通"（端口、body、路由写错），而不是缺 Origin。
      const withOrigin = await fetch(endpoint, {
        method: "POST",
        headers: { ...headers, Origin: apiOrigin },
        body,
      });

      expect(withOrigin.status).toBe(200);
      expect(tokenFrom(withOrigin)).not.toBe("");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("blocks_cross_site_navigation_sign_in_even_when_the_origin_is_trusted", async () => {
    // formCsrfMiddleware 在校验 Origin **之前**还有一条更严的分支：`Sec-Fetch-Site: cross-site`
    // 配 `Sec-Fetch-Mode: navigate`（跨站导航/表单登录的形态）直接 403
    // CROSS_SITE_NAVIGATION_LOGIN_BLOCKED——**发了可信 Origin 也救不回来**。
    // 必须钉住：契约第 5 节"补了 Sec-Fetch-* 就同时发 Origin"那条建议在这一格不成立，
    // 客户端不可热修，读契约的人得知道"发 Origin"不是万能解。
    const email = freshEmail();
    await signUp(email, PASSWORD, NATIVE);

    const crossSite = async (mode: string): Promise<Response> =>
      app.request(url("/api/auth/sign-in/email"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // 可信 Origin（=api 自己的源），照样过不了下面那条分支
          Origin: apiOrigin,
          "Sec-Fetch-Site": "cross-site",
          "Sec-Fetch-Mode": mode,
        },
        body: JSON.stringify({ email, password: PASSWORD }),
      });

    const blocked = await crossSite("navigate");

    expect(blocked.status).toBe(403);
    expect(betterAuthErrorSchema.parse(await blocked.json()).code).toBe(
      "CROSS_SITE_NAVIGATION_LOGIN_BLOCKED",
    );
    // 对照：只把 mode 从 navigate 换成 cors，同一个请求就是 200。少了这一句，上面的 403
    // 也可能是 Origin、账号或别的原因，而不是"跨站导航"这条分支。
    expect((await crossSite("cors")).status).toBe(200);
  });

  it("accepts_sign_out_with_a_bearer_token_and_no_origin_header", async () => {
    const token = tokenFrom(await signUp(freshEmail(), PASSWORD, noOrigin));
    // 先确认这个 token 本来是好用的。少了这一步，下面的 200 + 401 在"bearer 根本没生效"
    // 时也照样成立（sign-out 无会话时是幂等 200，/api/me 无凭证本就是 401）——那就是假绿。
    expect((await get("/api/me", { ...noOrigin, bearer: token })).status).toBe(200);

    const out = await post("/api/auth/sign-out", {}, { ...noOrigin, bearer: token });

    expect(out.status).toBe(200);
    expect((await get("/api/me", { ...noOrigin, bearer: token })).status).toBe(401);
  });

  it("accepts_me_with_a_bearer_token_and_no_origin_header", async () => {
    // /api/me 是本仓库自有路由，不经过 better-auth 的 origin 校验——但必须实测确认
    const email = freshEmail();
    const token = tokenFrom(await signUp(email, PASSWORD, noOrigin));

    const res = await get("/api/me", { ...noOrigin, bearer: token });

    expect(res.status).toBe(200);
    expect(meResponseSchema.parse(await res.json()).user.email).toBe(email);
  });

  it("still_rejects_sign_up_from_an_untrusted_origin_even_without_a_cookie", async () => {
    // 反面：客户端一旦发了 Origin，就必须发一个在信任清单里的值——不能随便编一个。
    const email = freshEmail();
    const res = await signUp(email, PASSWORD, { origin: "http://evil.example.com" });

    expect(res.status).toBe(403);
    expect(betterAuthErrorSchema.parse(await res.json()).code).toBe("INVALID_ORIGIN");
    expect(
      await db
        .select()
        .from(user)
        .where(inArray(user.email, [email])),
    ).toHaveLength(0);
  });

  it("does_not_check_origin_on_bearer_sign_out_even_when_the_origin_is_untrusted", async () => {
    // 契约 Origin 矩阵第三行第二格。今天成立的原因是：强制校验只发生在 sign-up/sign-in
    // （formCsrfMiddleware）或请求带 Cookie 时，bearer 的 sign-out 两条都不沾。
    // better-auth 一旦把校验改成无条件，这一格会先红——契约的立论就是每格都有测试钉住。
    const token = tokenFrom(await signUp(freshEmail(), PASSWORD, NATIVE));
    // 先确认 token 本来好用：少了这一步，"200 + 之后 401"在 bearer 完全没生效时也成立
    expect((await get("/api/me", { ...NATIVE, bearer: token })).status).toBe(200);

    const out = await post(
      "/api/auth/sign-out",
      {},
      { origin: "http://evil.example.com", bearer: token },
    );

    // 200 且会话真的被吊销——不是"被挡掉但幂等成功"
    expect(out.status).toBe(200);
    expect((await get("/api/me", { ...NATIVE, bearer: token })).status).toBe(401);
  });

  it("does_not_check_origin_on_our_own_protected_endpoint_even_when_the_origin_is_untrusted", async () => {
    // 契约 Origin 矩阵第三行第三格。/api/me 是本仓库自有路由，不经过 better-auth 的
    // origin 校验；跨源浏览器 JS 依然读不到响应（CORS 不回 allow-origin，app.test.ts 钉住）。
    const email = freshEmail();
    const token = tokenFrom(await signUp(email, PASSWORD, NATIVE));

    const res = await get("/api/me", { origin: "http://evil.example.com", bearer: token });

    expect(res.status).toBe(200);
    expect(meResponseSchema.parse(await res.json()).user.email).toBe(email);
  });

  it("still_requires_a_trusted_origin_once_the_request_carries_a_cookie", async () => {
    // cookie 路径的 CSRF 防护一点没松：带 cookie 就必须带可信 Origin。
    const cookie = cookieFrom(await signUp(freshEmail()));

    const res = await post("/api/auth/sign-out", {}, { cookie, origin: "http://evil.example.com" });

    expect(res.status).toBe(403);
    expect(betterAuthErrorSchema.parse(await res.json()).code).toBe("INVALID_ORIGIN");
  });
});

describe("the session token stays unreachable to browser javascript", () => {
  it("does_not_expose_the_token_header_to_cross_origin_browser_javascript", async () => {
    // set-auth-token 出现在**每个**建立会话的响应上，web 的也一样。web 用 httpOnly cookie，
    // 不需要读它；只要不 expose，跨源的浏览器 JS 就读不到——等于没给 XSS 多一个取 token 的口子。
    const res = await signUp(freshEmail());

    expect(res.status).toBe(200);
    expect(res.headers.get(SESSION_TOKEN_HEADER)).not.toBeNull();
    expect((res.headers.get("access-control-expose-headers") ?? "").toLowerCase()).not.toContain(
      SESSION_TOKEN_HEADER,
    );
    // CORS 的允许请求头清单里也没有 Authorization：浏览器发不出 bearer（预检就挡掉）
    const preflight = await app.request(url("/api/me"), {
      method: "OPTIONS",
      headers: { Origin: browserOrigin, "Access-Control-Request-Method": "GET" },
    });
    expect(preflight.headers.get("access-control-allow-headers") ?? "").not.toMatch(
      /authorization/i,
    );
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

  it("labels_the_auth_rate_limit_response_as_text_plain_even_though_it_is_json", async () => {
    // 契约里写明了这条，钉住它：better-auth 升级后要是改了，web 端的解析假设会跟着变
    const email = freshEmail();
    let limited: Response | undefined;
    for (let i = 0; i < 6 && limited === undefined; i += 1) {
      const res = await signIn(email, "wrong-password", asClient("203.0.113.60"), behindProxy);
      if (res.status === 429) {
        limited = res;
      }
    }

    if (limited === undefined) {
      throw new Error("expected better-auth to rate limit within 6 attempts");
    }
    expect(limited.headers.get("content-type")).toMatch(/text\/plain/);
    // 契约让客户端在 /api/auth/* 上读 X-Retry-After（自有端点是 Retry-After，名字不同）。
    // 这条不对称此前没有任何断言：better-auth 改名的话 api 测试照绿，而 web 的限流倒计时会
    // 静默退回默认值、iOS 按契约读的头永远为空。
    expect(limited.headers.get("x-retry-after") ?? "").toMatch(/^\d+$/);
    // 头说 text/plain，body 其实是 JSON——按 content-type 解析的客户端会拿到字符串
    expect(betterAuthErrorSchema.parse(JSON.parse(await limited.text())).code).toBeUndefined();
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

  it("rate_limits_the_bearer_path_on_our_own_endpoints_too", async () => {
    // bearer plugin 是 better-auth 的 hook，不碰我们的中间件链——但"新凭证形态绕过了限流"
    // 是这类改动最典型的翻车方式，所以正面钉住（security.md：所有对外 endpoint 有限流）。
    const tight = makeApp({
      trustedProxies: ["10.0.0.0/8"],
      rateLimit: { windowSeconds: 60, max: 3 },
    });
    const token = tokenFrom(await signUp(freshEmail(), PASSWORD, NATIVE));

    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const options = { ...NATIVE, ...asClient("203.0.113.40"), bearer: token };
      statuses.push((await get("/api/me", options, tight)).status);
    }

    // 前三次是已认证的 200——证明限流拦的是"额度用尽"，不是"凭证无效"
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it("rate_limits_sign_in_for_a_native_client_that_sends_no_origin", async () => {
    const email = freshEmail();
    await signUp(email, PASSWORD, NATIVE);
    await db.delete(rateLimit);

    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const options = { origin: null, ...asClient("203.0.113.70") };
      statuses.push((await signIn(email, "wrong-password", options, behindProxy)).status);
    }

    expect(statuses).toContain(429);
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

const CONSOLE_LEVELS = ["error", "warn", "log", "info", "debug", "trace"] as const;

/**
 * 在防护生效的前提下收集所有 console 输出。
 * 防护装在 spy **外面**（库 → 防护 → 出口），与生产里的层次一致；
 * 被测的 app 在防护装好之后才构造——better-auth 的 logger sink 是构造时就绑定的，
 * 生产里 index.ts 也是先装防护再造依赖。
 */
const captureConsole = async (
  act: (target: ReturnType<typeof makeApp>) => Promise<void>,
): Promise<string[]> => {
  const captured: string[] = [];
  const record = (...args: unknown[]): void => {
    captured.push(
      args.map((arg) => (typeof arg === "string" ? arg : (JSON.stringify(arg) ?? ""))).join(" "),
    );
  };
  const spies = CONSOLE_LEVELS.map((level) => vi.spyOn(console, level).mockImplementation(record));
  const restoreGuard = installConsoleRedaction();
  try {
    await act(makeApp({ auth: createAuth(db, config.auth) }));
  } finally {
    restoreGuard();
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
  return captured;
};

describe("logging on normal business paths", () => {
  it("keeps the email out of the log when an existing address is registered again", async () => {
    // better-auth 在这条路径上会 `logger.info(\`Sign-up attempt for existing email: ${email}\`)`
    // （sign-up.mjs），走的是我们配置的 logger，靠 level:"warn" 抑制。
    // 这是**正常业务路径**——任何用户重复注册都会走到，一旦 level 被调成 "info"，
    // 完整邮箱就会稳定、高频地进日志。所以钉住行为而不是配置值。
    const email = freshEmail();
    expect((await signUp(email)).status).toBe(200);

    let status = 0;
    const captured = await captureConsole(async (target) => {
      const res = await post(
        "/api/auth/sign-up/email",
        { name: "Dup", email, password: PASSWORD },
        {},
        target,
      );
      status = res.status;
    });

    // 422 证明确实走到了"邮箱已存在"这条分支，不是因为没跑到而假绿
    expect(status).toBe(422);
    expect(captured.join("\n")).not.toContain(email);
  });

  it("never logs the session token anywhere along the native happy path", async () => {
    // 会话 token 在两个头里出现：响应的 set-auth-token、请求的 Authorization。
    // 这条用例的价值在于**将来**：谁要是加一个打请求/响应头的中间件，这里立刻红。
    let token = "";
    const captured = await captureConsole(async (target) => {
      const email = freshEmail();
      const signedUp = await post(
        "/api/auth/sign-up/email",
        { name: "Native", email, password: PASSWORD },
        NATIVE,
        target,
      );
      token = tokenFrom(signedUp);
      // 先确认这一趟真的拿到了 token，否则下面的"没出现"是废断言
      expect(token).toMatch(TOKEN_FORMAT);

      const me = await get("/api/me", { ...NATIVE, bearer: token }, target);
      expect(me.status).toBe(200);
      const out = await post("/api/auth/sign-out", {}, { ...NATIVE, bearer: token }, target);
      expect(out.status).toBe(200);
    });

    const [tokenId = ""] = token.split(".");
    expect(captured.join("\n")).not.toContain(token);
    expect(captured.join("\n")).not.toContain(tokenId);
  });
});

describe("dependency failure", () => {
  /**
   * 把某张表改名，制造"只有依赖这张表的查询失败"的干净故障。
   * 三条路径都要覆盖：session 上的错误被 better-auth 包成 APIError 走 onError，
   * user / account 上的是裸抛，落到 better-call 里那句硬编码的 console.error——
   * 后者 logger 配置完全管不到，上一轮只测 session 所以假绿。
   */
  const withBrokenTable = async (table: string, act: () => Promise<void>): Promise<void> => {
    await db.execute(
      sql`alter table ${sql.identifier(table)} rename to ${sql.identifier(`${table}_fault`)}`,
    );
    try {
      await act();
    } finally {
      await db.execute(
        sql`alter table if exists ${sql.identifier(`${table}_fault`)} rename to ${sql.identifier(table)}`,
      );
    }
  };

  /** 禁列（security.md）：token、密码、哈希、完整邮箱，一个都不许进日志。 */
  const collectSecrets = async (
    email: string,
    cookie: string,
  ): Promise<{ label: string; value: string }[]> => {
    const [tokenId = ""] = decodeURIComponent(
      cookie.split("better-auth.session_token=")[1] ?? "",
    ).split(".");
    const [owner] = await db.select().from(user).where(eq(user.email, email));
    const [credential] = await db
      .select()
      .from(account)
      .where(eq(account.userId, owner?.id ?? ""));
    const hash = credential?.password ?? "";

    // 先确认这些值真的拿到了，否则下面的"没出现"全是废断言
    expect(tokenId).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(hash.length).toBeGreaterThan(16);

    return [
      { label: "session token", value: tokenId },
      { label: "email", value: email },
      { label: "password", value: PASSWORD },
      { label: "password hash", value: hash },
    ];
  };

  it.each([
    { table: "session", endpoint: "me" },
    { table: "user", endpoint: "signIn" },
    { table: "account", endpoint: "signIn" },
  ])(
    "keeps credentials out of the log when the $table table is unavailable",
    async ({ table, endpoint }) => {
      const email = freshEmail();
      const cookie = cookieFrom(await signUp(email));
      const secrets = await collectSecrets(email, cookie);

      let status = 0;
      let body = "";
      const captured = await captureConsole(async (target) => {
        await withBrokenTable(table, async () => {
          const res =
            endpoint === "me"
              ? await get("/api/me", { cookie }, target)
              : await signIn(email, PASSWORD, {}, target);
          status = res.status;
          body = await res.text();
        });
      });

      // 确实走到了故障路径并确实记了日志——否则"没有敏感值"会因为根本没日志而假绿
      expect(status).toBe(500);
      expect(captured.join("")).not.toBe("");

      const log = captured.join("\n");
      for (const secret of secrets) {
        expect(`${secret.label} in log: ${log.includes(secret.value)}`).toBe(
          `${secret.label} in log: false`,
        );
        expect(`${secret.label} in body: ${body.includes(secret.value)}`).toBe(
          `${secret.label} in body: false`,
        );
      }

      // drizzle 把绑定参数拼在 message 里，`params:` 是它的标志，一并挡掉
      expect(log).not.toContain("params:");
    },
  );

  it("keeps the bearer token out of the log when the session table is unavailable", async () => {
    // cookie 路径的同一条红线上面已经测过了。bearer 换了凭证的**载体**（请求头而不是
    // cookie），而 `/api/me` 查会话仍然是 `where "token" = $1`——drizzle 把绑定参数拼进
    // error.message，所以这条路径必须单独钉住，不能靠 cookie 那个用例代表。
    const email = freshEmail();
    const token = tokenFrom(await signUp(email, PASSWORD, NATIVE));
    const [tokenId = ""] = token.split(".");
    // 先确认拿到的是**签名过的**完整 token，否则下面的"没出现"全是废断言
    expect(tokenId).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(token.length).toBeGreaterThan(tokenId.length + 8);

    let status = 0;
    let body = "";
    const captured = await captureConsole(async (target) => {
      await withBrokenTable("session", async () => {
        const res = await get("/api/me", { ...NATIVE, bearer: token }, target);
        status = res.status;
        body = await res.text();
      });
    });

    // 确实走到了故障路径并确实记了日志——否则"没有敏感值"会因为根本没日志而假绿
    expect(status).toBe(500);
    expect(captured.join("")).not.toBe("");

    const log = captured.join("\n");
    for (const secret of [
      { label: "signed bearer token", value: token },
      { label: "session id", value: tokenId },
      { label: "email", value: email },
    ]) {
      expect(`${secret.label} in log: ${log.includes(secret.value)}`).toBe(
        `${secret.label} in log: false`,
      );
      expect(`${secret.label} in body: ${body.includes(secret.value)}`).toBe(
        `${secret.label} in body: false`,
      );
    }
    expect(log).not.toContain("params:");
  });

  it.each(["session", "user"])(
    "still records what broke when the %s table is unavailable",
    async (table) => {
      // 脱敏不能脱成一片空白：42P01 = undefined_table，是 Postgres 的结构化错误码，
      // 不含用户数据，正是"数据库挂了 vs 代码有 bug"的判据
      const email = freshEmail();
      const cookie = cookieFrom(await signUp(email));

      const captured = await captureConsole(async (target) => {
        await withBrokenTable(table, async () => {
          if (table === "session") {
            await get("/api/me", { cookie }, target);
          } else {
            await signIn(email, PASSWORD, {}, target);
          }
        });
      });

      expect(captured.join("\n")).toContain("DatabaseError");
      expect(captured.join("\n")).toContain("42P01");
    },
  );

  it("keeps serving normally once the database recovers", async () => {
    const cookie = cookieFrom(await signUp(freshEmail()));
    expect((await get("/api/me", { cookie })).status).toBe(200);
  });
});
