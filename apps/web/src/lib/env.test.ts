import { describe, expect, it } from "vitest";
import { resolveApiBaseUrl } from "./env";

describe("resolveApiBaseUrl", () => {
  it("接受合法的 http/https 地址", () => {
    expect(resolveApiBaseUrl("http://localhost:3001")).toBe("http://localhost:3001");
    expect(resolveApiBaseUrl("https://api.example.com")).toBe("https://api.example.com");
  });

  it("去掉末尾斜杠，避免拼出 //api/me", () => {
    expect(resolveApiBaseUrl("https://api.example.com/")).toBe("https://api.example.com");
    expect(resolveApiBaseUrl("https://api.example.com///")).toBe("https://api.example.com");
  });

  it("缺少配置时立刻失败，并在报错里点名该配哪个变量", () => {
    expect(() => resolveApiBaseUrl(undefined)).toThrowError(/NEXT_PUBLIC_API_BASE_URL/);
    expect(() => resolveApiBaseUrl("")).toThrowError(/NEXT_PUBLIC_API_BASE_URL/);
    expect(() => resolveApiBaseUrl("   ")).toThrowError(/NEXT_PUBLIC_API_BASE_URL/);
  });

  it("拒绝不是 URL 的值，而不是等到发请求时才炸", () => {
    expect(() => resolveApiBaseUrl("localhost:3001")).toThrowError(/NEXT_PUBLIC_API_BASE_URL/);
    expect(() => resolveApiBaseUrl("/api")).toThrowError(/NEXT_PUBLIC_API_BASE_URL/);
  });

  it("拒绝 http/https 之外的协议", () => {
    expect(() => resolveApiBaseUrl("ftp://api.example.com")).toThrowError(
      /NEXT_PUBLIC_API_BASE_URL/,
    );
    expect(() => resolveApiBaseUrl("javascript:alert(1)")).toThrowError(/NEXT_PUBLIC_API_BASE_URL/);
  });
});
