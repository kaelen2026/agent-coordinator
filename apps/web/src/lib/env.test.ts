import { describe, expect, it, vi } from "vitest";
import { getApiBaseUrl, resolveApiBaseUrl } from "./env";

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

describe("getApiBaseUrl 的构建期 / 运行期分界", () => {
  const PLACEHOLDER = "http://api-base-url-not-configured.invalid";

  /** 模拟服务端（构建预渲染 / SSR）：那里没有 window。 */
  const asServer = (fn: () => void) => {
    vi.stubGlobal("window", undefined);
    try {
      fn();
    } finally {
      vi.unstubAllGlobals();
    }
  };

  it("浏览器里配置正常时返回配置值", () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://api.example.com/");

    expect(getApiBaseUrl()).toBe("https://api.example.com");
  });

  it("浏览器里缺配置就抛错——运行期不给任何兜底", () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "");

    expect(() => getApiBaseUrl()).toThrowError(/NEXT_PUBLIC_API_BASE_URL/);
  });

  it("浏览器里配置非法同样抛错", () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "not-a-url");

    expect(() => getApiBaseUrl()).toThrowError(/NEXT_PUBLIC_API_BASE_URL/);
  });

  it("浏览器里永远不会拿到构建期占位值", () => {
    for (const raw of ["", "not-a-url"]) {
      vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", raw);
      expect(() => getApiBaseUrl()).toThrow();
    }
  });

  it("服务端缺配置时返回必定解析失败的占位值，而不是抛错——否则 next build 会挂", () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "");

    asServer(() => {
      expect(getApiBaseUrl()).toBe(PLACEHOLDER);
    });
  });

  it("占位值用的是 RFC 2606 保留域，绝不可能打到真实主机上", () => {
    expect(new URL(PLACEHOLDER).hostname.endsWith(".invalid")).toBe(true);
  });

  it("服务端配置正常时用真实值，不用占位值", () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://api.example.com");

    asServer(() => {
      expect(getApiBaseUrl()).toBe("https://api.example.com");
    });
  });

  it("服务端配置写错了仍然抛错——typo 要在构建期就暴露，不能被占位值掩盖", () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "localhost:3001");

    asServer(() => {
      expect(() => getApiBaseUrl()).toThrowError(/NEXT_PUBLIC_API_BASE_URL/);
    });
  });
});
