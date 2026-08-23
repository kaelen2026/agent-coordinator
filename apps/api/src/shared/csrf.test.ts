import { apiErrorSchema, bearerAuthorization } from "@agent-coordinator/contracts";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { csrfMiddleware } from "./csrf.js";
import { onError } from "./errors.js";

// 自有状态改变端点的 CSRF 防线。六格逐格钉住——"哪一格放行"就是这道防线的全部语义，
// 靠读代码看不出退化，只能靠测试。

const TRUSTED = "http://localhost:3000";
const UNTRUSTED = "http://evil.example.com";
const COOKIE = "better-auth.session_token=whatever";
const TOKEN = "session-id.signature";

const makeApp = (isExempt?: (path: string) => boolean) => {
  const app = new Hono();
  app.onError(onError);
  app.use("*", csrfMiddleware({ trustedOrigins: [TRUSTED], isExempt }));
  app.all("/api/things", (c) => c.json({ ok: true }));
  app.all("/api/auth/sign-in/email", (c) => c.json({ ok: true }));
  return app;
};

type Call = {
  method?: string;
  path?: string;
  cookie?: boolean;
  bearer?: boolean;
  origin?: string;
};

const call = async (options: Call = {}, app = makeApp()): Promise<Response> =>
  app.request(options.path ?? "/api/things", {
    method: options.method ?? "POST",
    headers: {
      ...(options.cookie === true ? { Cookie: COOKIE } : {}),
      ...(options.bearer === true ? { Authorization: bearerAuthorization(TOKEN) } : {}),
      ...(options.origin === undefined ? {} : { Origin: options.origin }),
    },
  });

const expectRejected = async (res: Response): Promise<void> => {
  expect(res.status).toBe(403);
  expect(apiErrorSchema.parse(await res.json()).error.code).toBe("INVALID_ORIGIN");
};

describe("csrf middleware", () => {
  describe("the six cells", () => {
    it("allows_a_cookie_request_from_a_trusted_origin", async () => {
      expect((await call({ cookie: true, origin: TRUSTED })).status).toBe(200);
    });

    it("rejects_a_cookie_request_from_an_untrusted_origin", async () => {
      await expectRejected(await call({ cookie: true, origin: UNTRUSTED }));
    });

    it("rejects_a_cookie_request_that_sends_no_origin_at_all", async () => {
      await expectRejected(await call({ cookie: true }));
    });

    it("allows_a_bearer_request_that_sends_no_origin", async () => {
      // 原生客户端（URLSession）默认不发 Origin，也不带 cookie
      expect((await call({ bearer: true })).status).toBe(200);
    });

    it("allows_a_bearer_request_even_from_an_untrusted_origin", async () => {
      // 这一格看着像漏洞，其实不是：CSRF 的前提是浏览器**自动附带**凭证，而只有 cookie 会
      // 被自动附带。攻击者的跨站页面读不到、也发不出 `Authorization` 头（它不在
      // Access-Control-Allow-Headers 里），所以它伪造出来的请求根本没有凭证——真打到这里
      // 就是 401，不是"以受害者身份写数据"。反过来说，如果这里也拦，iOS 就必须依赖对
      // URLSession 发什么头的推断才能通过，代价大而收益为零。
      expect((await call({ bearer: true, origin: UNTRUSTED })).status).toBe(200);
    });

    it("leaves_reads_alone_even_with_a_cookie_and_an_untrusted_origin", async () => {
      // GET 无副作用，CSRF 打不出伤害；拦它只会让跨源读取莫名 403
      expect((await call({ method: "GET", cookie: true, origin: UNTRUSTED })).status).toBe(200);
    });
  });

  describe("scope", () => {
    it.each(["PUT", "PATCH", "DELETE"])("guards_%s_as_well_as_post", async (method) => {
      await expectRejected(await call({ method, cookie: true, origin: UNTRUSTED }));
    });

    it("leaves_head_and_options_alone", async () => {
      expect((await call({ method: "OPTIONS", cookie: true, origin: UNTRUSTED })).status).toBe(200);
      expect((await call({ method: "HEAD", cookie: true, origin: UNTRUSTED })).status).toBe(200);
    });

    it("skips_paths_the_caller_declared_exempt", async () => {
      // better-auth 自己校验 /api/auth/*，并且报的是不同的 code（MISSING_OR_NULL_ORIGIN
      // 等，见 packages/contracts）——两层都拦的话它那套契约就被我们盖掉了
      const app = makeApp((path) => path.startsWith("/api/auth/"));
      const res = await call(
        { path: "/api/auth/sign-in/email", cookie: true, origin: UNTRUSTED },
        app,
      );

      expect(res.status).toBe(200);
    });

    it("still_guards_paths_outside_the_exemption", async () => {
      const app = makeApp((path) => path.startsWith("/api/auth/"));

      await expectRejected(await call({ cookie: true, origin: UNTRUSTED }, app));
    });
  });

  describe("origin matching", () => {
    it("rejects_an_origin_that_merely_starts_with_a_trusted_one", async () => {
      await expectRejected(await call({ cookie: true, origin: `${TRUSTED}.evil.example.com` }));
    });

    it("rejects_an_origin_that_only_differs_in_scheme", async () => {
      await expectRejected(await call({ cookie: true, origin: "https://localhost:3000" }));
    });

    it("rejects_an_origin_that_only_differs_in_port", async () => {
      await expectRejected(await call({ cookie: true, origin: "http://localhost:3001" }));
    });

    it("rejects_the_literal_null_origin_a_sandboxed_frame_sends", async () => {
      await expectRejected(await call({ cookie: true, origin: "null" }));
    });

    it("accepts_a_configured_entry_that_carries_a_trailing_slash", async () => {
      // AUTH_TRUSTED_ORIGINS 是给人填的 URL 清单，Origin 头是序列化后的源——
      // 比较前必须归一化，否则一个尾斜杠就让整个 web 端 403
      const app = new Hono();
      app.onError(onError);
      app.use("*", csrfMiddleware({ trustedOrigins: [`${TRUSTED}/`] }));
      app.post("/api/things", (c) => c.json({ ok: true }));

      expect((await call({ cookie: true, origin: TRUSTED }, app)).status).toBe(200);
    });

    it("does_not_echo_the_rejected_origin_back_to_the_caller", async () => {
      const res = await call({ cookie: true, origin: "http://attacker.example.com" });
      const body = await res.text();

      expect(res.status).toBe(403);
      expect(body).not.toContain("attacker.example.com");
    });
  });
});
