import { beforeEach, describe, expect, it, vi } from "vitest";
import { signIn, signOut, signUp } from "./actions";

/**
 * 这一层的价值在于「真实 better-auth 客户端 → 真实契约 schema → 失败归类」这条链路，
 * 所以只 stub 最外层的 `fetch`（唯一的外部边界），中间一律走真实代码。
 */

/** 路由桩：给定响应，或用 "network-error" 模拟连响应都没拿到（断网 / CORS 预检失败）。 */
type StubRoute =
  | { status: number; body: unknown; headers?: Record<string, string> }
  | "network-error";

let calls: { url: string; init: RequestInit | undefined }[] = [];

const stubRoutes = (routes: Record<string, StubRoute>) => {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const match = Object.entries(routes).find(([path]) => url.includes(path));
    if (match === undefined) throw new Error(`unstubbed request: ${url}`);
    const route = match[1];
    if (route === "network-error") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { "content-type": "application/json", ...(route.headers ?? {}) },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const sessionRoute: StubRoute = { status: 200, body: null };

const findCall = (path: string) => calls.find((call) => call.url.includes(path));

beforeEach(() => {
  calls = [];
});

describe("signIn 的请求构造", () => {
  it("打 better-auth 的 /api/auth/sign-in/email，带 cookie，且提交邮箱与密码", async () => {
    stubRoutes({
      "/sign-in/email": { status: 200, body: { token: "t", user: {}, redirect: false } },
      "/get-session": sessionRoute,
    });

    await signIn({ email: "a@example.com", password: "correct-horse-battery" });

    const call = findCall("/sign-in/email");
    expect(call?.url).toBe("http://api.test/api/auth/sign-in/email");
    expect(call?.init?.credentials).toBe("include");
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      email: "a@example.com",
      password: "correct-horse-battery",
    });
  });

  it("成功时不把响应体里的明文 token 透出去，也不写任何本地存储", async () => {
    stubRoutes({
      "/sign-in/email": {
        status: 200,
        body: { token: "plaintext-session-token", user: { id: "u1" }, redirect: false },
      },
      "/get-session": sessionRoute,
    });

    const result = await signIn({ email: "a@example.com", password: "correct-horse-battery" });

    expect(result).toEqual({ ok: true });
    expect(JSON.stringify(result)).not.toContain("plaintext-session-token");
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("signIn 的错误分支", () => {
  it("401 INVALID_EMAIL_OR_PASSWORD 归为凭证错", async () => {
    stubRoutes({
      "/sign-in/email": {
        status: 401,
        body: { message: "Invalid email or password", code: "INVALID_EMAIL_OR_PASSWORD" },
      },
    });

    const result = await signIn({ email: "a@example.com", password: "wrong-password-here" });

    expect(result).toEqual({ ok: false, failure: { kind: "invalid-credentials" } });
  });

  it("429 时从 X-Retry-After 头读出真实等待秒数（响应 content-type 是 text/plain 但 body 是 JSON）", async () => {
    stubRoutes({
      "/sign-in/email": {
        status: 429,
        body: { message: "Too many requests. Please try again later." },
        headers: { "content-type": "text/plain;charset=UTF-8", "X-Retry-After": "7" },
      },
    });

    const result = await signIn({ email: "a@example.com", password: "correct-horse-battery" });

    expect(result).toEqual({ ok: false, failure: { kind: "rate-limited", retryAfterSeconds: 7 } });
  });

  it("500 归为服务端错误，不向用户暴露内部信息", async () => {
    stubRoutes({
      "/sign-in/email": { status: 500, body: { message: "boom" } },
    });

    const result = await signIn({ email: "a@example.com", password: "correct-horse-battery" });

    expect(result).toEqual({ ok: false, failure: { kind: "server", status: 500 } });
  });

  it("网络失败（断网 / CORS 预检失败）归为 network，供 UI 给重试入口", async () => {
    stubRoutes({
      "/sign-in/email": "network-error",
    });

    const result = await signIn({ email: "a@example.com", password: "correct-horse-battery" });

    expect(result).toEqual({ ok: false, failure: { kind: "network" } });
  });
});

describe("signUp", () => {
  it("打 /api/auth/sign-up/email 并提交 name/email/password", async () => {
    stubRoutes({
      "/sign-up/email": { status: 200, body: { token: "t", user: {} } },
      "/get-session": sessionRoute,
    });

    const result = await signUp({
      name: "阿玖",
      email: "a@example.com",
      password: "correct-horse-battery",
    });

    expect(result).toEqual({ ok: true });
    const call = findCall("/sign-up/email");
    expect(call?.url).toBe("http://api.test/api/auth/sign-up/email");
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      name: "阿玖",
      email: "a@example.com",
      password: "correct-horse-battery",
    });
  });

  it("422 USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL 归为邮箱已占用", async () => {
    stubRoutes({
      "/sign-up/email": {
        status: 422,
        body: { message: "User already exists", code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" },
      },
    });

    const result = await signUp({
      name: "阿玖",
      email: "a@example.com",
      password: "correct-horse-battery",
    });

    expect(result).toEqual({ ok: false, failure: { kind: "email-taken" } });
  });

  it("400 PASSWORD_TOO_SHORT 归为字段校验错并保留 code", async () => {
    stubRoutes({
      "/sign-up/email": {
        status: 400,
        body: { message: "Password too short", code: "PASSWORD_TOO_SHORT" },
      },
    });

    const result = await signUp({ name: "阿玖", email: "a@example.com", password: "short" });

    expect(result).toEqual({
      ok: false,
      failure: { kind: "invalid-input", code: "PASSWORD_TOO_SHORT" },
    });
  });
});

describe("signOut", () => {
  it("打 /api/auth/sign-out 并带上 cookie", async () => {
    stubRoutes({
      "/sign-out": { status: 200, body: { success: true } },
      "/get-session": sessionRoute,
    });

    const result = await signOut();

    expect(result).toEqual({ ok: true });
    const call = findCall("/sign-out");
    expect(call?.url).toBe("http://api.test/api/auth/sign-out");
    expect(call?.init?.credentials).toBe("include");
  });

  it("登出失败时如实返回失败，不假装已经登出", async () => {
    stubRoutes({ "/sign-out": { status: 500, body: { message: "boom" } } });

    const result = await signOut();

    expect(result).toEqual({ ok: false, failure: { kind: "server", status: 500 } });
  });
});
