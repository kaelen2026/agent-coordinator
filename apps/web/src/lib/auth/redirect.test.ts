import { describe, expect, it } from "vitest";
import { DEFAULT_AFTER_AUTH_PATH, safeRedirectTarget, signInPathFor } from "./redirect";

describe("safeRedirectTarget", () => {
  it("放行站内的绝对路径", () => {
    expect(safeRedirectTarget("/dashboard")).toBe("/dashboard");
    expect(safeRedirectTarget("/dashboard?tab=a#b")).toBe("/dashboard?tab=a#b");
  });

  it("缺失或为空时回落到默认落地页", () => {
    expect(safeRedirectTarget(null)).toBe(DEFAULT_AFTER_AUTH_PATH);
    expect(safeRedirectTarget(undefined)).toBe(DEFAULT_AFTER_AUTH_PATH);
    expect(safeRedirectTarget("")).toBe(DEFAULT_AFTER_AUTH_PATH);
    expect(safeRedirectTarget("   ")).toBe(DEFAULT_AFTER_AUTH_PATH);
  });

  it("拒绝站外地址，避免登录跳转变成开放重定向", () => {
    expect(safeRedirectTarget("https://evil.example.com")).toBe(DEFAULT_AFTER_AUTH_PATH);
    expect(safeRedirectTarget("http://evil.example.com/x")).toBe(DEFAULT_AFTER_AUTH_PATH);
  });

  it("拒绝协议相对地址（//host 会被浏览器当成站外）", () => {
    expect(safeRedirectTarget("//evil.example.com")).toBe(DEFAULT_AFTER_AUTH_PATH);
    expect(safeRedirectTarget("/\\evil.example.com")).toBe(DEFAULT_AFTER_AUTH_PATH);
    expect(safeRedirectTarget("/\t/evil.example.com")).toBe(DEFAULT_AFTER_AUTH_PATH);
  });

  it("拒绝 javascript: 之类的伪协议", () => {
    expect(safeRedirectTarget("javascript:alert(1)")).toBe(DEFAULT_AFTER_AUTH_PATH);
    expect(safeRedirectTarget("data:text/html,x")).toBe(DEFAULT_AFTER_AUTH_PATH);
  });

  it("拒绝不以 / 开头的相对路径（无法判定归属）", () => {
    expect(safeRedirectTarget("dashboard")).toBe(DEFAULT_AFTER_AUTH_PATH);
    expect(safeRedirectTarget("../admin")).toBe(DEFAULT_AFTER_AUTH_PATH);
  });

  it("拒绝把用户重新送回登录页，避免登录成功后原地打转", () => {
    expect(safeRedirectTarget("/sign-in")).toBe(DEFAULT_AFTER_AUTH_PATH);
    expect(safeRedirectTarget("/sign-in?redirectTo=%2Fdashboard")).toBe(DEFAULT_AFTER_AUTH_PATH);
    expect(safeRedirectTarget("/sign-up")).toBe(DEFAULT_AFTER_AUTH_PATH);
  });
});

describe("signInPathFor", () => {
  it("把当前路径编码进 redirectTo，登录后能回到原处", () => {
    expect(signInPathFor("/dashboard?tab=profile")).toBe(
      "/sign-in?redirectTo=%2Fdashboard%3Ftab%3Dprofile",
    );
  });

  it("站外或非法的来源先被消毒成默认落地页，不会原样写进 redirectTo", () => {
    expect(signInPathFor("https://evil.example.com")).toBe(
      `/sign-in?redirectTo=${encodeURIComponent(DEFAULT_AFTER_AUTH_PATH)}`,
    );
    expect(signInPathFor("javascript:alert(1)")).toBe(
      `/sign-in?redirectTo=${encodeURIComponent(DEFAULT_AFTER_AUTH_PATH)}`,
    );
  });

  it("默认落地页也照常带上参数，不做特例", () => {
    expect(signInPathFor(DEFAULT_AFTER_AUTH_PATH)).toBe("/sign-in?redirectTo=%2Fdashboard");
  });
});
