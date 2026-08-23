import { randomUUID } from "node:crypto";
import {
  apiErrorSchema,
  bearerAuthorization,
  createTaskResponseSchema,
  meResponseSchema,
  SESSION_TOKEN_HEADER,
  type Task,
  taskListResponseSchema,
} from "@agent-coordinator/contracts";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AppDeps, createApp } from "../../app.js";
import { createDb, createPool, type Db } from "../../shared/db.js";
import { type AppConfig, loadConfig } from "../../shared/env.js";
import { createRateLimiter } from "../../shared/rate-limit.js";
import { apiRateLimit } from "../../shared/rate-limit.schema.js";
import { createAuth, userTable } from "../auth/index.js";
import { createTaskRepo } from "./repo.js";
import { task } from "./schema.js";

// 打真实 Postgres（compose.yaml 起的实例），不 mock 数据库——mock 出来的 SQL 永远是对的。
// 认证也走真实 better-auth 会话（cookie 与 bearer 两条凭证路径都测）。
// 每个测试自建自清数据：邮箱随机，结束删自己建的 user（task 由外键级联删除）。

const config: AppConfig = loadConfig();
const pool: Pool = createPool(config.db);
const db: Db = createDb(pool);
const auth = createAuth(db, config.auth);
const rateLimiter = createRateLimiter(db);

const makeApp = (overrides: Partial<AppDeps> = {}) =>
  createApp({
    auth,
    tasks: { repo: createTaskRepo(db), newId: () => randomUUID() },
    rateLimiter,
    // 默认放宽限流，让这些用例聚焦任务行为；429 由下面专门的分组用收紧的额度测
    rateLimit: { windowSeconds: 60, max: 10_000 },
    allowedOrigins: config.auth.trustedOrigins,
    apiBaseUrl: config.auth.baseUrl,
    trustedProxies: [],
    maxBodyBytes: config.http.maxBodyBytes,
    ...overrides,
  });

const app = makeApp();

/**
 * 注册专用的 app：**每个新用户从一个不同的客户端 IP 注册**。
 *
 * better-auth 自己对 sign-up 限流（10 秒窗口、按 IP 分桶），而 `app.request()` 拿不到
 * socket 地址、所有请求都落进同一个 `unknown` 桶——本文件几十个用例各建一个用户，很快就
 * 会被它挡成 429，测的就不是任务行为了。让每次注册来自不同 IP 是真实形态（不同用户本来
 * 就是不同客户端），也让本文件不依赖 better-auth 限流表的清理时机。
 */
const signUpApp = makeApp({ trustedProxies: ["10.0.0.0/8"] });
let clientSeq = 0;
// 203.0.113.0/24 是 RFC 5737 保留给文档/测试的网段
const nextForwardedFor = (): string => `203.0.113.${(clientSeq++ % 254) + 1}, 10.0.0.1`;

const PASSWORD = "correct-horse-battery-staple";
const createdEmails: string[] = [];

const url = (path: string): string => `${config.auth.baseUrl}${path}`;

// 浏览器一定会带 Origin；契约要求 iOS 固定发 api 自己的源（也在信任清单里）
const [browserOrigin = "http://localhost:3000"] = config.auth.trustedOrigins;
const UNTRUSTED_ORIGIN = "http://evil.example.com";

type Credentials = {
  userId: string;
  /** web 路径：会话 cookie。 */
  cookie: string;
  /** 原生路径：bearer token。 */
  token: string;
};

type Call = {
  /** `null` = 一个 Origin 头都不发。默认发可信的浏览器源。 */
  origin?: string | null;
  cookie?: string;
  bearer?: string;
  headers?: Record<string, string>;
};

const headersFor = ({ origin, cookie, bearer, headers = {} }: Call): Record<string, string> => ({
  ...(origin === undefined ? { Origin: browserOrigin } : origin === null ? {} : { Origin: origin }),
  ...(cookie === undefined ? {} : { Cookie: cookie }),
  ...(bearer === undefined ? {} : { Authorization: bearerAuthorization(bearer) }),
  ...headers,
});

const postJson = async (
  path: string,
  body: unknown,
  call: Call = {},
  target = app,
): Promise<Response> =>
  target.request(url(path), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headersFor(call) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const get = async (path: string, call: Call = {}, target = app): Promise<Response> =>
  target.request(url(path), { headers: headersFor(call) });

const cookieFrom = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0])
    .filter((entry): entry is string => entry !== undefined && entry.length > 0)
    .join("; ");

/** 建一个真实用户并拿到两条凭证路径的凭证。 */
const signUpUser = async (): Promise<Credentials> => {
  const email = `task-test-${randomUUID()}@example.test`;
  createdEmails.push(email);

  const res = await postJson(
    "/api/auth/sign-up/email",
    { name: "Task Test User", email, password: PASSWORD },
    { headers: { "X-Forwarded-For": nextForwardedFor() } },
    signUpApp,
  );
  expect(res.status).toBe(200);

  const cookie = cookieFrom(res);
  const token = res.headers.get(SESSION_TOKEN_HEADER) ?? "";
  expect(token).not.toBe("");

  const me = await get("/api/me", { cookie });
  expect(me.status).toBe(200);
  const { user } = meResponseSchema.parse(await me.json());

  return { userId: user.id, cookie, token };
};

const createTaskVia = async (
  credentials: Credentials,
  body: unknown = { title: "a task" },
): Promise<Task> => {
  const res = await postJson("/api/tasks", body, { cookie: credentials.cookie });
  expect(res.status).toBe(201);
  return createTaskResponseSchema.parse(await res.json()).task;
};

const listVia = async (credentials: Credentials, query = ""): Promise<Response> =>
  get(`/api/tasks${query}`, { cookie: credentials.cookie });

const expectApiError = async (res: Response, status: number, code: string): Promise<void> => {
  expect(res.status).toBe(status);
  expect(apiErrorSchema.parse(await res.json()).error.code).toBe(code);
};

const countTasksOf = async (userId: string): Promise<number> =>
  (await db.select({ id: task.id }).from(task).where(eq(task.userId, userId))).length;

beforeEach(async () => {
  // 限流计数是跨测试的共享状态，清掉才可重复
  await db.delete(apiRateLimit);
});

afterEach(async () => {
  if (createdEmails.length > 0) {
    await db.delete(userTable).where(inArray(userTable.email, createdEmails));
    createdEmails.length = 0;
  }
});

afterAll(async () => {
  await pool.end();
});

describe("POST /api/tasks", () => {
  it("creates_a_task_for_the_calling_user_and_returns_it", async () => {
    const owner = await signUpUser();

    const res = await postJson(
      "/api/tasks",
      { title: "  write the slice  ", description: "  with detail  " },
      { cookie: owner.cookie },
    );

    expect(res.status).toBe(201);
    const { task: created } = createTaskResponseSchema.parse(await res.json());
    expect(created.title).toBe("write the slice");
    expect(created.description).toBe("with detail");
    expect(Date.parse(created.createdAt)).not.toBeNaN();

    const stored = await db.select().from(task).where(eq(task.id, created.id));
    expect(stored[0]?.userId).toBe(owner.userId);
  });

  it("returns_only_the_whitelisted_task_fields", async () => {
    // 不暴露 updatedAt（本切片没有更新路径）、status（本切片没有生命周期）、userId
    const owner = await signUpUser();

    const created = await createTaskVia(owner);

    expect(Object.keys(created).sort()).toEqual(["createdAt", "description", "id", "title"]);
  });

  it("does_not_send_a_location_header", async () => {
    // 契约里的显式缺口：本切片没有 GET /api/tasks/{id}，指向必然 404 的 Location 比不给更糟
    const owner = await signUpUser();

    const res = await postJson("/api/tasks", { title: "a task" }, { cookie: owner.cookie });

    expect(res.headers.get("location")).toBeNull();
  });

  it("stores_a_missing_description_as_null", async () => {
    const owner = await signUpUser();

    const created = await createTaskVia(owner, { title: "no description" });

    expect(created.description).toBeNull();
  });

  it("stores_a_blank_description_as_null_rather_than_an_empty_string", async () => {
    const owner = await signUpUser();

    const created = await createTaskVia(owner, { title: "blank", description: "   " });

    expect(created.description).toBeNull();
    const stored = await db.select().from(task).where(eq(task.id, created.id));
    expect(stored[0]?.description).toBeNull();
  });

  it("accepts_a_title_and_description_at_the_maximum_length", async () => {
    const owner = await signUpUser();

    const created = await createTaskVia(owner, {
      title: "t".repeat(200),
      description: "d".repeat(2000),
    });

    expect(created.title).toHaveLength(200);
    expect(created.description).toHaveLength(2000);
  });

  it("works_for_a_native_client_holding_a_bearer_token", async () => {
    const owner = await signUpUser();

    const res = await postJson(
      "/api/tasks",
      { title: "from ios" },
      { cookie: undefined, bearer: owner.token, origin: new URL(config.auth.baseUrl).origin },
    );

    expect(res.status).toBe(201);
    expect(createTaskResponseSchema.parse(await res.json()).task.title).toBe("from ios");
  });

  it("creates_a_second_task_when_the_same_request_is_replayed", async () => {
    // 契约里的显式缺口：本切片**不支持** Idempotency-Key，重放会建第二条。
    // 客户端因此不得对 POST 的超时/网络失败做自动重试。这条测试钉住这个缺口，
    // 将来补幂等键时它应该被明确地改掉，而不是悄悄变绿。
    const owner = await signUpUser();
    const body = { title: "same request" };
    const key = { "Idempotency-Key": randomUUID() };

    const first = await postJson("/api/tasks", body, { cookie: owner.cookie, headers: key });
    const second = await postJson("/api/tasks", body, { cookie: owner.cookie, headers: key });

    expect([first.status, second.status]).toEqual([201, 201]);
    const one = createTaskResponseSchema.parse(await first.json()).task;
    const two = createTaskResponseSchema.parse(await second.json()).task;
    expect(one.id).not.toBe(two.id);
    expect(await countTasksOf(owner.userId)).toBe(2);
  });

  describe("rejects invalid input with 400", () => {
    const badBodies: Array<[string, unknown]> = [
      ["a missing title", {}],
      ["an empty title", { title: "" }],
      ["a whitespace only title", { title: "   " }],
      ["a title over 200 characters", { title: "t".repeat(201) }],
      ["a non string title", { title: 42 }],
      ["a description over 2000 characters", { title: "ok", description: "d".repeat(2001) }],
      ["a non string description", { title: "ok", description: 1 }],
      ["a body that is not an object", "[]"],
    ];

    it.each(badBodies)("rejects_%s", async (_name, body) => {
      const owner = await signUpUser();

      const res = await postJson("/api/tasks", body, { cookie: owner.cookie });

      await expectApiError(res, 400, "VALIDATION_ERROR");
      expect(await countTasksOf(owner.userId)).toBe(0);
    });

    it("rejects_a_body_that_is_not_json_at_all", async () => {
      const owner = await signUpUser();

      const res = await postJson("/api/tasks", "not json at all", { cookie: owner.cookie });

      await expectApiError(res, 400, "VALIDATION_ERROR");
    });

    it("does_not_echo_the_rejected_input_back_to_the_caller", async () => {
      const owner = await signUpUser();

      const res = await postJson(
        "/api/tasks",
        { title: "", description: "sensitive-payload" },
        { cookie: owner.cookie },
      );

      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain("sensitive-payload");
    });
  });

  it("rejects_a_caller_with_no_credentials", async () => {
    await expectApiError(await postJson("/api/tasks", { title: "x" }), 401, "UNAUTHENTICATED");
  });

  it("rejects_a_caller_whose_bearer_token_is_invalid", async () => {
    const res = await postJson(
      "/api/tasks",
      { title: "x" },
      { bearer: "not-a-real-token.signature" },
    );

    await expectApiError(res, 401, "UNAUTHENTICATED");
  });

  it("rejects_a_body_over_the_global_limit_with_413", async () => {
    const owner = await signUpUser();
    const oversized = JSON.stringify({ title: "x".repeat(config.http.maxBodyBytes + 1) });

    const res = await postJson("/api/tasks", oversized, {
      cookie: owner.cookie,
      headers: { "Content-Length": String(Buffer.byteLength(oversized)) },
    });

    await expectApiError(res, 413, "PAYLOAD_TOO_LARGE");
  });

  it("rejects_a_caller_over_the_rate_limit_with_429_and_retry_after", async () => {
    const tight = makeApp({ rateLimit: { windowSeconds: 60, max: 1 } });

    const first = await postJson("/api/tasks", { title: "x" }, {}, tight);
    const second = await postJson("/api/tasks", { title: "x" }, {}, tight);

    expect(first.status).toBe(401);
    await expectApiError(second, 429, "RATE_LIMITED");
    expect(second.headers.get("retry-after")).not.toBeNull();
  });
});

describe("CSRF on POST /api/tasks", () => {
  // 六格逐格钉住（中间件级的隔离测试在 shared/csrf.test.ts，这里是真端点 + 真会话）
  it("allows_a_cookie_request_from_a_trusted_origin", async () => {
    const owner = await signUpUser();

    const res = await postJson("/api/tasks", { title: "ok" }, { cookie: owner.cookie });

    expect(res.status).toBe(201);
  });

  it("rejects_a_cookie_request_from_an_untrusted_origin_and_writes_nothing", async () => {
    const owner = await signUpUser();

    const res = await postJson(
      "/api/tasks",
      { title: "forged" },
      { cookie: owner.cookie, origin: UNTRUSTED_ORIGIN },
    );

    await expectApiError(res, 403, "INVALID_ORIGIN");
    expect(await countTasksOf(owner.userId)).toBe(0);
  });

  it("rejects_a_cookie_request_that_sends_no_origin_and_writes_nothing", async () => {
    const owner = await signUpUser();

    const res = await postJson(
      "/api/tasks",
      { title: "forged" },
      { cookie: owner.cookie, origin: null },
    );

    await expectApiError(res, 403, "INVALID_ORIGIN");
    expect(await countTasksOf(owner.userId)).toBe(0);
  });

  it("allows_a_bearer_request_that_sends_no_origin", async () => {
    const owner = await signUpUser();

    const res = await postJson(
      "/api/tasks",
      { title: "ok" },
      { bearer: owner.token, origin: null },
    );

    expect(res.status).toBe(201);
  });

  it("allows_a_bearer_request_even_from_an_untrusted_origin", async () => {
    // 不是漏洞：`Authorization` 头不会被浏览器自动附带，攻击者的跨站页面发不出它，
    // 所以这一格根本没有可被冒用的凭证。理由详见 shared/csrf.ts。
    const owner = await signUpUser();

    const res = await postJson(
      "/api/tasks",
      { title: "ok" },
      { bearer: owner.token, origin: UNTRUSTED_ORIGIN },
    );

    expect(res.status).toBe(201);
  });

  it("allows_a_native_client_that_carries_both_a_cookie_and_a_bearer_token", async () => {
    // 第七格 —— iOS 的真实形态：better-auth 的 sign-in 响应除了 `set-auth-token` 也下发
    // 会话 cookie（这半句本套件自己验过：signUpUser 取到的 cookie 能换 /api/me 200），而
    // "默认 URLSession（httpShouldSetCookies + 共享 jar）会把它收进去"这半句是按 Apple 文档
    // **推断的、本仓库未实测**（口径同 packages/contracts 第 4 节）。推断若成立，
    // 之后每个请求**同时**带 Authorization 与 Cookie，于是必然走进 Origin 校验分支，
    // 不走"不带 cookie 就跳过"那条。契约要求 iOS 固定发 `Origin: <api 自身的源>`，
    // 而那个值不在 AUTH_TRUSTED_ORIGINS 里（.env.example 还明确要求 iOS 别往里加东西），
    // 所以可信集合必须像 better-auth 的 getTrustedOrigins 那样恒含 api 自身的源。
    // 不通过的代价：iOS 全部写操作 403，而客户端不可热修。
    const owner = await signUpUser();

    const res = await postJson(
      "/api/tasks",
      { title: "from ios" },
      {
        cookie: owner.cookie,
        bearer: owner.token,
        origin: new URL(config.auth.baseUrl).origin,
      },
    );

    expect(res.status).toBe(201);
  });

  it("rejects_a_cookie_request_from_an_untrusted_origin_before_checking_the_session", async () => {
    // Origin 校验排在认证之前：垃圾 cookie（没有任何有效会话）+ 不可信 Origin 拿到的是 403，
    // 不是 401。把 csrfMiddleware 从全局挪到 requireAuth 之后（看着像"只保护要认证的写接口"
    // 的合理重构）就会把它变成 401，客户端于是走重登录流程而不是报"来源不可信"。
    const res = await postJson(
      "/api/tasks",
      { title: "forged" },
      { cookie: "better-auth.session_token=not-a-real-session", origin: UNTRUSTED_ORIGIN },
    );

    await expectApiError(res, 403, "INVALID_ORIGIN");
  });

  it("leaves_the_list_endpoint_alone_even_with_a_cookie_and_an_untrusted_origin", async () => {
    const owner = await signUpUser();

    const res = await get("/api/tasks", { cookie: owner.cookie, origin: UNTRUSTED_ORIGIN });

    expect(res.status).toBe(200);
  });

  it("does_not_reflect_the_rejected_origin_into_the_response", async () => {
    const owner = await signUpUser();

    const res = await postJson(
      "/api/tasks",
      { title: "forged" },
      { cookie: owner.cookie, origin: "http://attacker.example.com" },
    );

    expect(await res.text()).not.toContain("attacker.example.com");
  });
});

describe("GET /api/tasks", () => {
  it("returns_the_callers_tasks_newest_first", async () => {
    const owner = await signUpUser();
    const first = await createTaskVia(owner, { title: "first" });
    const second = await createTaskVia(owner, { title: "second" });

    const res = await listVia(owner);

    expect(res.status).toBe(200);
    const page = taskListResponseSchema.parse(await res.json());
    expect(page.tasks.map((entry) => entry.id)).toEqual([second.id, first.id]);
    expect(page.nextCursor).toBeNull();
  });

  it("returns_an_empty_page_with_a_null_cursor_for_a_user_with_no_tasks", async () => {
    const owner = await signUpUser();

    const page = taskListResponseSchema.parse(await (await listVia(owner)).json());

    expect(page).toEqual({ tasks: [], nextCursor: null });
  });

  it("never_leaks_another_users_tasks", async () => {
    // 越权（IDOR）：归属过滤在 service 层，不是"路由层查了登录态就算完"
    const alice = await signUpUser();
    const bob = await signUpUser();
    const aliceTask = await createTaskVia(alice, { title: "alice private" });
    const bobTask = await createTaskVia(bob, { title: "bob private" });

    const bobPage = taskListResponseSchema.parse(await (await listVia(bob)).json());

    expect(bobPage.tasks.map((entry) => entry.id)).toEqual([bobTask.id]);
    expect(JSON.stringify(bobPage)).not.toContain("alice private");
    expect(bobPage.tasks.map((entry) => entry.id)).not.toContain(aliceTask.id);
  });

  it("does_not_let_a_cursor_from_another_users_page_reach_that_users_rows", async () => {
    const alice = await signUpUser();
    const bob = await signUpUser();
    await createTaskVia(alice, { title: "alice one" });
    await createTaskVia(alice, { title: "alice two" });

    const alicePage = taskListResponseSchema.parse(await (await listVia(alice, "?limit=1")).json());
    expect(alicePage.nextCursor).not.toBeNull();

    const bobPage = taskListResponseSchema.parse(
      await (
        await listVia(bob, `?cursor=${encodeURIComponent(alicePage.nextCursor ?? "")}`)
      ).json(),
    );

    expect(bobPage.tasks).toEqual([]);
  });

  it("works_for_a_native_client_holding_a_bearer_token", async () => {
    const owner = await signUpUser();
    const created = await createTaskVia(owner, { title: "from ios" });

    const res = await get("/api/tasks", { bearer: owner.token, origin: null });

    expect(res.status).toBe(200);
    const page = taskListResponseSchema.parse(await res.json());
    expect(page.tasks.map((entry) => entry.id)).toEqual([created.id]);
  });

  it("rejects_a_caller_with_no_credentials", async () => {
    await expectApiError(await get("/api/tasks"), 401, "UNAUTHENTICATED");
  });

  it("rejects_a_caller_over_the_rate_limit_with_429", async () => {
    const tight = makeApp({ rateLimit: { windowSeconds: 60, max: 1 } });

    expect((await get("/api/tasks", {}, tight)).status).toBe(401);
    await expectApiError(await get("/api/tasks", {}, tight), 429, "RATE_LIMITED");
  });

  describe("rejects invalid query parameters with 400", () => {
    const badQueries = [
      "?limit=0",
      "?limit=101",
      "?limit=-1",
      "?limit=1.5",
      "?limit=abc",
      "?limit=",
      "?cursor=",
      "?cursor=not-a-cursor",
      "?cursor=%%%",
    ];

    it.each(badQueries)("rejects_%s", async (query) => {
      const owner = await signUpUser();

      await expectApiError(await listVia(owner, query), 400, "VALIDATION_ERROR");
    });

    it("accepts_the_boundary_page_sizes", async () => {
      const owner = await signUpUser();

      expect((await listVia(owner, "?limit=1")).status).toBe(200);
      expect((await listVia(owner, "?limit=100")).status).toBe(200);
    });
  });

  it("defaults_to_a_page_size_of_twenty", async () => {
    const owner = await signUpUser();
    for (let i = 0; i < 21; i += 1) {
      await createTaskVia(owner, { title: `task ${i}` });
    }

    const page = taskListResponseSchema.parse(await (await listVia(owner)).json());

    expect(page.tasks).toHaveLength(20);
    expect(page.nextCursor).not.toBeNull();
  });
});

describe("the list query is served by the index", () => {
  /**
   * EXPLAIN 的是 **repo 真正发出的那条 SQL**（用 drizzle 的 logger 抓下来），不是手抄的副本：
   * 手抄的话 repo 改了查询、这条测试照样绿，等于白测。
   */
  const explainListQuery = async (
    userId: string,
    after: { createdAt: Date; id: string } | null,
  ): Promise<string> => {
    const captured: Array<{ query: string; params: unknown[] }> = [];
    // 专用连接池：下面要改 planner 开关，不能污染 app 共用的那个池子。
    // poolMax=1 保证 `set` 和 `explain` 落在同一条连接上。
    const probePool = createPool({ ...config.db, poolMax: 1 });
    try {
      const logged = drizzle(probePool, {
        logger: { logQuery: (query, params) => captured.push({ query, params }) },
      });
      await createTaskRepo(logged).listByOwner({ userId, limit: 21, after });
      const executed = captured[0];
      expect(executed).toBeDefined();

      // 表里只有几行时 planner 当然会选顺扫或位图扫，那看不出任何东西。把这两条路都关掉，
      // 问的就是另一个问题了：**这个索引能不能独自满足这条查询的排序**——能，就是干净的
      // Index Scan；不能，planner 只能拿它当过滤条件、再加一个 Sort 把该用户的全部任务排一遍。
      // 这样断言与表里有多少行无关（位图扫在小表上恒定更便宜，留着它测试就随数据量翻脸）。
      await probePool.query("set enable_seqscan = off; set enable_bitmapscan = off");
      const plan = await probePool.query(
        `explain ${executed?.query ?? ""}`,
        (executed?.params ?? []) as unknown[],
      );
      return plan.rows.map((row: Record<string, string>) => row["QUERY PLAN"]).join("\n");
    } finally {
      await probePool.end();
    }
  };

  it("orders_by_the_index_instead_of_sorting_rows_in_memory", async () => {
    const owner = await signUpUser();
    await createTaskVia(owner);

    const plan = await explainListQuery(owner.userId, null);

    expect(plan).toContain("task_user_id_created_at_id_idx");
    // Sort 节点出现就意味着索引的排序声明与 ORDER BY 不匹配（NULLS FIRST/LAST 是最常见的
    // 原因），代价是每翻一页都要把该用户的全部任务排一遍。
    expect(plan).not.toContain("Sort");
  });

  it("keeps_the_index_scan_when_paging_with_a_cursor", async () => {
    const owner = await signUpUser();
    const created = await createTaskVia(owner);

    const plan = await explainListQuery(owner.userId, {
      createdAt: new Date(created.createdAt),
      id: created.id,
    });

    expect(plan).toContain("task_user_id_created_at_id_idx");
    expect(plan).not.toContain("Sort");
  });
});

describe("cursor pagination", () => {
  /** 顺着 nextCursor 一路翻到底，返回每一页的 id。 */
  const walkPages = async (credentials: Credentials, limit: number): Promise<string[][]> => {
    const pages: string[][] = [];
    let cursor: string | null = null;

    for (let guard = 0; guard < 20; guard += 1) {
      const query =
        cursor === null
          ? `?limit=${limit}`
          : `?limit=${limit}&cursor=${encodeURIComponent(cursor)}`;
      const res = await listVia(credentials, query);
      expect(res.status).toBe(200);
      const page = taskListResponseSchema.parse(await res.json());
      pages.push(page.tasks.map((entry) => entry.id));
      cursor = page.nextCursor;
      if (cursor === null) {
        return pages;
      }
    }
    throw new Error("pagination did not terminate");
  };

  it("walks_every_task_exactly_once", async () => {
    const owner = await signUpUser();
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      created.push((await createTaskVia(owner, { title: `task ${i}` })).id);
    }

    const pages = await walkPages(owner, 2);
    const walked = pages.flat();

    expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
    // 创建顺序的逆序 = createdAt DESC
    expect(walked).toEqual([...created].reverse());
    expect(new Set(walked).size).toBe(created.length);
  });

  it("walks_rows_that_share_a_timestamp_exactly_once_using_the_id_as_tiebreak", async () => {
    // 并列是游标分页最容易漏/重的地方，而 createdAt 只有毫秒精度——真实并发下同毫秒
    // 完全可能。这里直接把多条任务的 createdAt 改成同一时刻来构造它。
    const owner = await signUpUser();
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      created.push((await createTaskVia(owner, { title: `tied ${i}` })).id);
    }

    const tied = new Date("2026-08-22T10:00:00.000Z");
    const older = new Date("2026-08-22T09:00:00.000Z");
    const [a, b, c, d, e] = created;
    await db
      .update(task)
      .set({ createdAt: tied })
      .where(
        inArray(
          task.id,
          [a, b, c].filter((id): id is string => id !== undefined),
        ),
      );
    await db
      .update(task)
      .set({ createdAt: older })
      .where(
        inArray(
          task.id,
          [d, e].filter((id): id is string => id !== undefined),
        ),
      );

    const pages = await walkPages(owner, 2);
    const walked = pages.flat();

    // 期望顺序：先并列的三条（按 id 倒序），再较老的两条（同样按 id 倒序）
    const byIdDesc = (ids: Array<string | undefined>): string[] =>
      ids
        .filter((id): id is string => id !== undefined)
        .sort()
        .reverse();
    expect(walked).toEqual([...byIdDesc([a, b, c]), ...byIdDesc([d, e])]);
    expect(new Set(walked).size).toBe(created.length);
    expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
  });

  it("stops_with_a_null_cursor_when_the_last_page_is_exactly_full", async () => {
    const owner = await signUpUser();
    for (let i = 0; i < 4; i += 1) {
      await createTaskVia(owner, { title: `task ${i}` });
    }

    const pages = await walkPages(owner, 2);

    expect(pages.map((page) => page.length)).toEqual([2, 2]);
  });

  /**
   * 直接把 `created_at` 写成**带微秒**的值。整毫秒（`.xxx000`）恰好会屏蔽这个 bug，
   * 所以这里必须用非整毫秒——参数化传值，不拼 SQL。
   */
  const setCreatedAtWithMicroseconds = async (id: string, value: string): Promise<void> => {
    await db.execute(sql`update "task" set created_at = ${value}::timestamptz where id = ${id}`);
  };

  it("stores_created_at_at_millisecond_precision_so_a_cursor_can_address_it_exactly", async () => {
    // 游标编码走 Date.toISOString()：只有毫秒，而且是**截断**不是四舍五入。列只要比游标精确，
    // keyset 上界就会被截到 `.xxx000`，真实值大于它的那条在之后任何一页都不会再出现。
    // 所以列精度必须与游标能表达的精度对齐——这条直接钉住列本身。
    const owner = await signUpUser();
    const created = await createTaskVia(owner);

    await setCreatedAtWithMicroseconds(created.id, "2026-08-22T10:00:00.123456+00");
    const stored = await db.execute(
      sql`select to_char(created_at, 'US') as micros from "task" where id = ${created.id}`,
    );

    expect(stored.rows[0]).toMatchObject({ micros: "123000" });
  });

  it("walks_every_row_exactly_once_when_timestamps_carry_sub_millisecond_precision", async () => {
    const owner = await signUpUser();
    const created: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      created.push((await createTaskVia(owner, { title: `micros ${i}` })).id);
    }

    // 三组"同一毫秒内的两条"。配 limit=1 时每一行都是页边界，所以每组里**较小的那条**都落在
    // 「大于被截断的上界、又小于边界行」的缝里——列若是微秒精度，这三条在之后任何一页都不会
    // 再出现。注意不能用整毫秒（.xxx000）构造：那恰好让截断无损，会把这个 bug 屏蔽掉。
    const micros = [
      "2026-08-22T10:00:00.123900+00",
      "2026-08-22T10:00:00.123100+00",
      "2026-08-22T10:00:00.122900+00",
      "2026-08-22T10:00:00.122100+00",
      "2026-08-22T10:00:00.121900+00",
      "2026-08-22T10:00:00.121100+00",
    ];
    for (const [i, value] of micros.entries()) {
      const id = created[i];
      if (id !== undefined) {
        await setCreatedAtWithMicroseconds(id, value);
      }
    }

    const walked = (await walkPages(owner, 1)).flat();

    expect(walked).toHaveLength(created.length);
    expect(new Set(walked)).toEqual(new Set(created));
  });

  it("walks_every_row_exactly_once_when_tasks_are_created_concurrently", async () => {
    // 真实形态：同一用户并发建任务，时间戳由 defaultNow() 给、不做任何加工。
    //
    // ⚠️ 证据等级：这条是**冒烟**，不是上面那条的替代品。走完整 HTTP 栈时两条请求是否真的
    // 落进同一毫秒取决于机器快慢，所以它在"列精度错了"的情况下**不保证变红**（实测就有过
    // 全绿）；确定性的那条是上面显式写微秒的用例。修好之后这条恒绿：毫秒列 + id 决胜下，
    // 并发建了多少条就该翻出多少条。
    const owner = await signUpUser();
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_unused, i) =>
        postJson("/api/tasks", { title: `concurrent ${i}` }, { cookie: owner.cookie }),
      ),
    );
    const created = await Promise.all(
      responses.map(async (res) => {
        expect(res.status).toBe(201);
        return createTaskResponseSchema.parse(await res.json()).task.id;
      }),
    );

    const walked = (await walkPages(owner, 1)).flat();

    expect(walked).toHaveLength(created.length);
    expect(new Set(walked)).toEqual(new Set(created));
  });

  it("returns_an_empty_final_page_rather_than_repeating_rows_when_a_cursor_is_replayed", async () => {
    const owner = await signUpUser();
    const first = await createTaskVia(owner, { title: "one" });
    await createTaskVia(owner, { title: "two" });

    const page = taskListResponseSchema.parse(await (await listVia(owner, "?limit=1")).json());
    const cursor = encodeURIComponent(page.nextCursor ?? "");

    const replayed = taskListResponseSchema.parse(
      await (await listVia(owner, `?limit=1&cursor=${cursor}`)).json(),
    );
    const replayedAgain = taskListResponseSchema.parse(
      await (await listVia(owner, `?limit=1&cursor=${cursor}`)).json(),
    );

    expect(replayed.tasks.map((entry) => entry.id)).toEqual([first.id]);
    expect(replayedAgain).toEqual(replayed);
  });
});
