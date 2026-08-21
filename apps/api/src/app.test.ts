import { apiErrorSchema, healthResponseSchema } from "@agent-coordinator/contracts";
import { describe, expect, it } from "vitest";
import { type AppDeps, createApp } from "./app.js";
import type { AuthGateway } from "./modules/auth/index.js";
import { CLIENT_IP_HEADER } from "./shared/client-ip.js";
import type { RateLimiter, RateLimitRule } from "./shared/rate-limit.js";

const ALLOWED_ORIGIN = "http://localhost:3000";
const MAX_BODY_BYTES = 1024;
const GENEROUS: RateLimitRule = { windowSeconds: 60, max: 1000 };

const anonymousAuth: AuthGateway = {
  handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  api: { getSession: async () => null },
};

/** 记录分桶键的假限流器：真实的落库实现在 shared/rate-limit.test.ts 打真库测。 */
const countingLimiter = (): { limiter: RateLimiter; keys: string[] } => {
  const keys: string[] = [];
  const counts = new Map<string, number>();
  const limiter: RateLimiter = async (key, rule) => {
    keys.push(key);
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return { allowed: next <= rule.max, retryAfterSeconds: 30 };
  };
  return { limiter, keys };
};

const makeApp = (overrides: Partial<AppDeps> = {}) =>
  createApp({
    auth: anonymousAuth,
    rateLimiter: countingLimiter().limiter,
    rateLimit: GENEROUS,
    allowedOrigins: [ALLOWED_ORIGIN],
    trustedProxies: [],
    maxBodyBytes: MAX_BODY_BYTES,
    ...overrides,
  });

describe("app", () => {
  it("healthz_returns_contract_shaped_ok", async () => {
    const res = await makeApp().request("/healthz");
    expect(res.status).toBe(200);
    const parsed = healthResponseSchema.parse(await res.json());
    expect(parsed.status).toBe("ok");
  });

  it("unknown_route_returns_contract_shaped_404", async () => {
    const res = await makeApp().request("/no-such-route");
    expect(res.status).toBe(404);
    const parsed = apiErrorSchema.parse(await res.json());
    expect(parsed.error.code).toBe("NOT_FOUND");
  });

  it("me_without_session_returns_unauthenticated", async () => {
    const res = await makeApp().request("/api/me");
    expect(res.status).toBe(401);
    const parsed = apiErrorSchema.parse(await res.json());
    expect(parsed.error.code).toBe("UNAUTHENTICATED");
  });

  it("oversized_body_is_rejected_before_reaching_the_handler", async () => {
    const res = await makeApp().request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "999999" },
      body: "x".repeat(MAX_BODY_BYTES + 1),
    });
    expect(res.status).toBe(413);
    const parsed = apiErrorSchema.parse(await res.json());
    expect(parsed.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("allows_credentialed_cors_only_for_trusted_origins", async () => {
    const res = await makeApp().request("/healthz", { headers: { Origin: ALLOWED_ORIGIN } });
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("does_not_echo_cors_headers_for_untrusted_origins", async () => {
    const res = await makeApp().request("/healthz", {
      headers: { Origin: "http://evil.example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).not.toBe("http://evil.example.com");
    expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  describe("rate limiting", () => {
    it("rejects_a_client_over_budget_with_429_and_retry_after", async () => {
      const { limiter } = countingLimiter();
      const app = makeApp({ rateLimiter: limiter, rateLimit: { windowSeconds: 60, max: 2 } });

      expect((await app.request("/api/me")).status).toBe(401);
      expect((await app.request("/api/me")).status).toBe(401);

      const res = await app.request("/api/me");
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("30");
      expect(apiErrorSchema.parse(await res.json()).error.code).toBe("RATE_LIMITED");
    });

    it("exempts_health_checks_so_probes_cannot_mark_the_instance_unhealthy", async () => {
      const { limiter, keys } = countingLimiter();
      const app = makeApp({ rateLimiter: limiter, rateLimit: { windowSeconds: 60, max: 1 } });

      for (let i = 0; i < 5; i += 1) {
        expect((await app.request("/healthz")).status).toBe(200);
      }
      expect(keys).toEqual([]);
    });

    it("buckets_per_client_and_per_path", async () => {
      const { limiter, keys } = countingLimiter();
      const app = makeApp({
        rateLimiter: limiter,
        trustedProxies: ["10.0.0.0/8"],
      });

      await app.request("/api/me", {
        headers: { "X-Forwarded-For": "203.0.113.7, 10.0.0.1" },
      });
      await app.request("/healthz-not-exempt-path", {
        headers: { "X-Forwarded-For": "203.0.113.8, 10.0.0.1" },
      });

      expect(keys).toEqual(["203.0.113.7|/api/me", "203.0.113.8|/healthz-not-exempt-path"]);
    });

    it("ignores_a_client_supplied_internal_ip_header_when_choosing_the_bucket", async () => {
      // 外部传进来的内部头必须被覆盖，否则客户端可以自选限流桶来绕过限流
      const { limiter, keys } = countingLimiter();
      const app = makeApp({ rateLimiter: limiter });

      await app.request("/api/me", { headers: { [CLIENT_IP_HEADER]: "1.2.3.4" } });

      expect(keys).toEqual(["unknown|/api/me"]);
    });
  });
});
