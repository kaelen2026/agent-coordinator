import { describe, expect, it } from "vitest";
import {
  classifyApiFailure,
  classifyAuthFailure,
  FALLBACK_RETRY_AFTER_SECONDS,
  networkFailure,
} from "./failure";

const headers = (init: Record<string, string> = {}) => new Headers(init);

describe("classifyAuthFailure（better-auth /api/auth/* 的错误形状）", () => {
  it("把 400 VALIDATION_ERROR 归为字段校验错并保留 code", () => {
    const failure = classifyAuthFailure({
      status: 400,
      body: { message: "invalid email", code: "VALIDATION_ERROR" },
      headers: headers(),
    });

    expect(failure).toEqual({ kind: "invalid-input", code: "VALIDATION_ERROR" });
  });

  it("区分密码过短与密码过长", () => {
    expect(
      classifyAuthFailure({
        status: 400,
        body: { message: "too short", code: "PASSWORD_TOO_SHORT" },
        headers: headers(),
      }),
    ).toEqual({ kind: "invalid-input", code: "PASSWORD_TOO_SHORT" });

    expect(
      classifyAuthFailure({
        status: 400,
        body: { message: "too long", code: "PASSWORD_TOO_LONG" },
        headers: headers(),
      }),
    ).toEqual({ kind: "invalid-input", code: "PASSWORD_TOO_LONG" });
  });

  it("把 401 INVALID_EMAIL_OR_PASSWORD 归为凭证错，且不携带任何区分账号是否存在的信息", () => {
    const failure = classifyAuthFailure({
      status: 401,
      body: { message: "Invalid email or password", code: "INVALID_EMAIL_OR_PASSWORD" },
      headers: headers(),
    });

    expect(failure).toEqual({ kind: "invalid-credentials" });
  });

  it("把 422 USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL 归为邮箱已占用", () => {
    const failure = classifyAuthFailure({
      status: 422,
      body: { message: "exists", code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" },
      headers: headers(),
    });

    expect(failure).toEqual({ kind: "email-taken" });
  });

  it("429 从 X-Retry-After 读等待秒数，而不是写死常量", () => {
    const failure = classifyAuthFailure({
      status: 429,
      body: { message: "Too many requests" },
      headers: headers({ "X-Retry-After": "7" }),
    });

    expect(failure).toEqual({ kind: "rate-limited", retryAfterSeconds: 7 });
  });

  it("429 读不到 X-Retry-After 时退避到自己的默认值", () => {
    const failure = classifyAuthFailure({
      status: 429,
      body: { message: "Too many requests" },
      headers: headers(),
    });

    expect(failure).toEqual({
      kind: "rate-limited",
      retryAfterSeconds: FALLBACK_RETRY_AFTER_SECONDS,
    });
  });

  it("429 时不读自有端点的 Retry-After 头（两种限流的头名字不同）", () => {
    const failure = classifyAuthFailure({
      status: 429,
      body: { message: "Too many requests" },
      headers: headers({ "Retry-After": "999" }),
    });

    expect(failure).toEqual({
      kind: "rate-limited",
      retryAfterSeconds: FALLBACK_RETRY_AFTER_SECONDS,
    });
  });

  it("429 的 body 没有 code 时也不能崩（better-auth 限流响应无 code）", () => {
    expect(() =>
      classifyAuthFailure({ status: 429, body: { message: "x" }, headers: headers() }),
    ).not.toThrow();
  });

  it("忽略非法的 X-Retry-After 值，退避到默认值", () => {
    for (const raw of ["", "abc", "-3", "0", "1.5", "NaN"]) {
      const failure = classifyAuthFailure({
        status: 429,
        body: { message: "x" },
        headers: headers({ "X-Retry-After": raw }),
      });
      expect(failure).toEqual({
        kind: "rate-limited",
        retryAfterSeconds: FALLBACK_RETRY_AFTER_SECONDS,
      });
    }
  });

  it("把超大的重试秒数收敛到上限，避免渲染出荒谬的倒计时", () => {
    const failure = classifyAuthFailure({
      status: 429,
      body: { message: "x" },
      headers: headers({ "X-Retry-After": "99999999" }),
    });

    expect(failure).toEqual({ kind: "rate-limited", retryAfterSeconds: 3600 });
  });

  it("把 403 MISSING_OR_NULL_ORIGIN / INVALID_ORIGIN 归为 forbidden 并保留 code 便于排障", () => {
    expect(
      classifyAuthFailure({
        status: 403,
        body: { message: "no origin", code: "MISSING_OR_NULL_ORIGIN" },
        headers: headers(),
      }),
    ).toEqual({ kind: "forbidden", code: "MISSING_OR_NULL_ORIGIN" });
  });

  it("把 5xx 归为服务端错误（客户端无法区分是自己传错还是后端挂了）", () => {
    expect(classifyAuthFailure({ status: 500, body: { message: "" }, headers: headers() })).toEqual(
      { kind: "server", status: 500 },
    );
    expect(classifyAuthFailure({ status: 503, body: null, headers: headers() })).toEqual({
      kind: "server",
      status: 503,
    });
  });

  it("body 不符合 betterAuthErrorSchema 时降级为 unexpected，而不是抛异常", () => {
    const failure = classifyAuthFailure({
      status: 400,
      body: { nope: true },
      headers: headers(),
    });

    expect(failure).toEqual({ kind: "unexpected", status: 400 });
  });

  it("认识范围外的 code 归为 unexpected，不冒充已知分支", () => {
    const failure = classifyAuthFailure({
      status: 418,
      body: { message: "teapot", code: "SOME_FUTURE_CODE" },
      headers: headers(),
    });

    expect(failure).toEqual({ kind: "unexpected", status: 418 });
  });
});

describe("classifyApiFailure（自有端点的 apiErrorSchema 形状）", () => {
  it("把 401 UNAUTHENTICATED 归为未登录", () => {
    const failure = classifyApiFailure({
      status: 401,
      body: { error: { code: "UNAUTHENTICATED", message: "authentication required", details: [] } },
      headers: headers(),
    });

    expect(failure).toEqual({ kind: "unauthenticated" });
  });

  it("429 从 Retry-After 读等待秒数（自有端点用的是不带 X- 前缀的头）", () => {
    const failure = classifyApiFailure({
      status: 429,
      body: { error: { code: "RATE_LIMITED", message: "too many requests", details: [] } },
      headers: headers({ "Retry-After": "45" }),
    });

    expect(failure).toEqual({ kind: "rate-limited", retryAfterSeconds: 45 });
  });

  it("429 时不读 better-auth 的 X-Retry-After 头", () => {
    const failure = classifyApiFailure({
      status: 429,
      body: { error: { code: "RATE_LIMITED", message: "x", details: [] } },
      headers: headers({ "X-Retry-After": "999" }),
    });

    expect(failure).toEqual({
      kind: "rate-limited",
      retryAfterSeconds: FALLBACK_RETRY_AFTER_SECONDS,
    });
  });

  it("把 5xx 归为服务端错误", () => {
    expect(classifyApiFailure({ status: 500, body: null, headers: headers() })).toEqual({
      kind: "server",
      status: 500,
    });
  });

  it("body 不符合 apiErrorSchema 时降级为 unexpected", () => {
    expect(
      classifyApiFailure({ status: 404, body: "<html>gateway</html>", headers: headers() }),
    ).toEqual({ kind: "unexpected", status: 404 });
  });

  it("不把 better-auth 的错误形状误认成自有端点的形状", () => {
    const failure = classifyApiFailure({
      status: 401,
      body: { message: "Invalid email or password", code: "INVALID_EMAIL_OR_PASSWORD" },
      headers: headers(),
    });

    expect(failure).toEqual({ kind: "unexpected", status: 401 });
  });
});

describe("networkFailure", () => {
  it("网络失败是独立分支，供 UI 给出重试入口", () => {
    expect(networkFailure()).toEqual({ kind: "network" });
  });
});
