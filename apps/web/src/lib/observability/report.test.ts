import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthFailure } from "../auth/failure";
import { reportAuthFailure } from "./report";

// 每个用例自己装 spy：vitest 配置开了 restoreMocks，模块级的 spy 会在首个用例后被还原。
const spyOnConsoleError = () => vi.spyOn(console, "error").mockImplementation(() => {});

let consoleError: ReturnType<typeof spyOnConsoleError>;

beforeEach(() => {
  consoleError = spyOnConsoleError();
});

const serialized = () => JSON.stringify(consoleError.mock.calls);

describe("reportAuthFailure", () => {
  it("上报操作名与失败种类，便于和后端日志对齐排障", () => {
    reportAuthFailure("sign-in", { kind: "server", status: 500 });

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(serialized()).toContain("sign-in");
    expect(serialized()).toContain("server");
    expect(serialized()).toContain("500");
  });

  it("不上报用户主动造成的失败——那不是故障，只会淹没真正的告警", () => {
    reportAuthFailure("sign-in", { kind: "invalid-credentials" });
    reportAuthFailure("sign-up", { kind: "email-taken" });
    reportAuthFailure("sign-up", { kind: "invalid-input", code: "PASSWORD_TOO_SHORT" });
    reportAuthFailure("me", { kind: "unauthenticated" });
    reportAuthFailure("sign-in", { kind: "rate-limited", retryAfterSeconds: 7 });

    expect(consoleError).not.toHaveBeenCalled();
  });

  it("上报真正的故障：网络、服务端、配置被拒、未知分支", () => {
    const faults: AuthFailure[] = [
      { kind: "network" },
      { kind: "server", status: 503 },
      { kind: "forbidden", code: "MISSING_OR_NULL_ORIGIN" },
      { kind: "unexpected", status: 418 },
    ];

    for (const failure of faults) {
      reportAuthFailure("sign-in", failure);
    }

    expect(consoleError).toHaveBeenCalledTimes(faults.length);
  });

  it("上报内容里不含任何凭证字段", () => {
    reportAuthFailure("sign-in", { kind: "server", status: 500 });

    const payload = serialized();
    expect(payload).not.toMatch(/password|token|secret|cookie/i);
  });
});
