import { apiErrorSchema, healthResponseSchema } from "@agent-coordinator/contracts";
import { describe, expect, it } from "vitest";
import { type AppDeps, createApp } from "./app.js";
import type { AuthGateway } from "./modules/auth/index.js";

const ALLOWED_ORIGIN = "http://localhost:3000";
const MAX_BODY_BYTES = 1024;

// 无会话的假 gateway：组装层的行为（CORS、体积上限、未认证拒绝）与数据库无关，
// 真正打库的注册/登录/登出在 modules/auth/auth.integration.test.ts。
const anonymousAuth: AuthGateway = {
  handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  api: { getSession: async () => null },
};

const makeApp = (overrides: Partial<AppDeps> = {}) =>
  createApp({
    auth: anonymousAuth,
    allowedOrigins: [ALLOWED_ORIGIN],
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
});
