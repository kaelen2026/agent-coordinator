import { describe, expect, it } from "vitest";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, signInSchema, signUpSchema } from "./forms";

const validPassword = "a".repeat(PASSWORD_MIN_LENGTH);

const firstIssue = (result: { success: false; error: { issues: { message: string }[] } }) =>
  result.error.issues[0]?.message ?? "";

describe("signInSchema", () => {
  it("接受合法的邮箱与密码", () => {
    const result = signInSchema.safeParse({ email: "a@example.com", password: validPassword });

    expect(result.success).toBe(true);
  });

  it("拒绝格式非法的邮箱", () => {
    const result = signInSchema.safeParse({ email: "not-an-email", password: validPassword });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(firstIssue(result)).toMatch(/邮箱/);
  });

  it("拒绝空密码", () => {
    const result = signInSchema.safeParse({ email: "a@example.com", password: "" });

    expect(result.success).toBe(false);
  });

  it("登录不校验密码长度——否则改过密码规则的老用户会被前端拦在门外", () => {
    const result = signInSchema.safeParse({ email: "a@example.com", password: "short" });

    expect(result.success).toBe(true);
  });

  it("去掉邮箱两端空白后再校验", () => {
    const result = signInSchema.safeParse({ email: "  a@example.com  ", password: validPassword });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error("unreachable");
    expect(result.data.email).toBe("a@example.com");
  });
});

describe("signUpSchema", () => {
  it("接受合法的姓名、邮箱与密码", () => {
    const result = signUpSchema.safeParse({
      name: "阿玖",
      email: "a@example.com",
      password: validPassword,
    });

    expect(result.success).toBe(true);
  });

  it("拒绝空姓名", () => {
    const result = signUpSchema.safeParse({
      name: "   ",
      email: "a@example.com",
      password: validPassword,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(firstIssue(result)).toMatch(/姓名|名字/);
  });

  it("按后端规则拒绝过短的密码，避免白白消耗限流额度", () => {
    const result = signUpSchema.safeParse({
      name: "阿玖",
      email: "a@example.com",
      password: "a".repeat(PASSWORD_MIN_LENGTH - 1),
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(firstIssue(result)).toContain(String(PASSWORD_MIN_LENGTH));
  });

  it("按后端规则拒绝过长的密码", () => {
    const result = signUpSchema.safeParse({
      name: "阿玖",
      email: "a@example.com",
      password: "a".repeat(PASSWORD_MAX_LENGTH + 1),
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(firstIssue(result)).toContain(String(PASSWORD_MAX_LENGTH));
  });

  it("边界长度的密码都放行", () => {
    for (const length of [PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH]) {
      const result = signUpSchema.safeParse({
        name: "阿玖",
        email: "a@example.com",
        password: "a".repeat(length),
      });
      expect(result.success, `length=${length}`).toBe(true);
    }
  });

  it("密码长度限制与 api 的 better-auth 配置一致（12 / 128）", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(PASSWORD_MAX_LENGTH).toBe(128);
  });
});
