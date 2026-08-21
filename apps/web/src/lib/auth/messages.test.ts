import { describe, expect, it } from "vitest";
import type { AuthFailure } from "./failure";
import { authFailureMessage, rateLimitMessage } from "./messages";

const allFailures: AuthFailure[] = [
  { kind: "invalid-input", code: "VALIDATION_ERROR" },
  { kind: "invalid-input", code: "PASSWORD_TOO_SHORT" },
  { kind: "invalid-input", code: "PASSWORD_TOO_LONG" },
  { kind: "invalid-input", code: "BAD_REQUEST" },
  { kind: "invalid-credentials" },
  { kind: "email-taken" },
  { kind: "unauthenticated" },
  { kind: "rate-limited", retryAfterSeconds: 10 },
  { kind: "forbidden", code: "MISSING_OR_NULL_ORIGIN" },
  { kind: "server", status: 500 },
  { kind: "network" },
  { kind: "unexpected", status: 418 },
];

describe("authFailureMessage", () => {
  it("每个失败分支都有非空的用户可读文案", () => {
    for (const failure of allFailures) {
      expect(authFailureMessage(failure), failure.kind).toMatch(/\S/);
    }
  });

  it("密码过短与密码过长给出不同的、可操作的提示", () => {
    const tooShort = authFailureMessage({ kind: "invalid-input", code: "PASSWORD_TOO_SHORT" });
    const tooLong = authFailureMessage({ kind: "invalid-input", code: "PASSWORD_TOO_LONG" });

    expect(tooShort).not.toBe(tooLong);
    expect(tooShort).toContain("12");
    expect(tooLong).toContain("128");
  });

  it("凭证错的文案不泄露账号是否存在", () => {
    const message = authFailureMessage({ kind: "invalid-credentials" });

    expect(message).not.toMatch(/未注册|不存在|没有该账号|no such user/i);
    expect(message).toMatch(/邮箱或密码/);
  });

  it("邮箱已占用与凭证错是不同文案", () => {
    expect(authFailureMessage({ kind: "email-taken" })).not.toBe(
      authFailureMessage({ kind: "invalid-credentials" }),
    );
  });

  it("服务端错与网络错都引导稍后重试，且不暴露状态码等内部信息", () => {
    const server = authFailureMessage({ kind: "server", status: 503 });
    const network = authFailureMessage({ kind: "network" });

    expect(server).toContain("稍后");
    expect(server).not.toContain("503");
    expect(network).toMatch(/网络/);
  });

  it("限流文案带上等待秒数", () => {
    expect(authFailureMessage({ kind: "rate-limited", retryAfterSeconds: 7 })).toContain("7");
  });
});

describe("rateLimitMessage", () => {
  it("按剩余秒数渲染倒计时提示", () => {
    expect(rateLimitMessage(9)).toContain("9");
    expect(rateLimitMessage(1)).toContain("1");
  });

  it("倒计时归零后改为提示可以重试，而不是显示 0 秒", () => {
    const message = rateLimitMessage(0);

    expect(message).not.toContain("0 秒");
    expect(message).toMatch(/可以重试|重新提交/);
  });
});
