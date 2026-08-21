import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./env.js";

// 密钥现生成，仓库里不存在固定值
const SECRET = randomBytes(32).toString("hex");
const DB_URL = "postgres://user:pw@db.internal:5432/app";

const env = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  DATABASE_URL: DB_URL,
  BETTER_AUTH_SECRET: SECRET,
  ...overrides,
});

const prod = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
  env({
    NODE_ENV: "production",
    BETTER_AUTH_URL: "https://api.example.com",
    AUTH_TRUSTED_ORIGINS: "https://app.example.com",
    AUTH_TRUSTED_PROXIES: "none",
    ...overrides,
  });

describe("loadConfig", () => {
  it("fails_when_the_auth_secret_is_missing", () => {
    expect(() => loadConfig(env({ BETTER_AUTH_SECRET: undefined }))).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("fails_when_the_auth_secret_is_too_short_to_be_a_real_key", () => {
    expect(() => loadConfig(env({ BETTER_AUTH_SECRET: "short" }))).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("fails_when_the_database_url_is_missing", () => {
    expect(() => loadConfig(env({ DATABASE_URL: undefined }))).toThrow(/DATABASE_URL/);
  });

  it("never_echoes_secret_bearing_values_in_the_error", () => {
    // DATABASE_URL 自带口令，报错回显它等于把凭证写进日志
    let message = "";
    try {
      loadConfig(env({ AUTH_TRUSTED_ORIGINS: "not-a-url" }));
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toMatch(/AUTH_TRUSTED_ORIGINS/);
    expect(message).not.toContain(DB_URL);
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain("pw");
  });

  describe("in development", () => {
    it("defaults_the_urls_and_treats_the_service_as_directly_exposed", () => {
      const config = loadConfig(env());
      expect(config.auth.baseUrl).toBe("http://localhost:3001");
      expect(config.auth.trustedOrigins).toEqual(["http://localhost:3000"]);
      expect(config.auth.trustedProxies).toEqual([]);
    });

    it("still_starts_when_the_optional_vars_are_present_but_empty", () => {
      const config = loadConfig(
        env({ BETTER_AUTH_URL: "", AUTH_TRUSTED_ORIGINS: "", AUTH_TRUSTED_PROXIES: "" }),
      );
      expect(config.auth.baseUrl).toBe("http://localhost:3001");
      expect(config.auth.trustedProxies).toEqual([]);
    });
  });

  describe("in production", () => {
    it("refuses_to_default_the_public_base_url", () => {
      // baseURL 的 scheme 决定 cookie 的 Secure/__Secure- 前缀，兜底成 http 会发出不带 Secure 的会话 cookie
      expect(() => loadConfig(prod({ BETTER_AUTH_URL: undefined }))).toThrow(/BETTER_AUTH_URL/);
    });

    it("refuses_to_default_the_trusted_origin_allowlist", () => {
      expect(() => loadConfig(prod({ AUTH_TRUSTED_ORIGINS: undefined }))).toThrow(
        /AUTH_TRUSTED_ORIGINS/,
      );
    });

    it("refuses_to_start_when_the_proxy_topology_was_never_declared", () => {
      // 漏配会让限流退化成全站共享桶，必须是启动失败而不是静默自伤
      expect(() => loadConfig(prod({ AUTH_TRUSTED_PROXIES: undefined }))).toThrow(
        /AUTH_TRUSTED_PROXIES/,
      );
    });

    it("treats_an_empty_value_as_never_declared_rather_than_as_a_valid_answer", () => {
      // 部署系统里空串和没设是一回事，不能让空串蒙混成"已声明"
      expect(() => loadConfig(prod({ AUTH_TRUSTED_PROXIES: "" }))).toThrow(/AUTH_TRUSTED_PROXIES/);
      expect(() => loadConfig(prod({ BETTER_AUTH_URL: "" }))).toThrow(/BETTER_AUTH_URL/);
    });

    it("accepts_an_explicit_declaration_of_direct_exposure", () => {
      expect(loadConfig(prod({ AUTH_TRUSTED_PROXIES: "none" })).auth.trustedProxies).toEqual([]);
    });

    it("accepts_a_list_of_proxy_addresses_and_cidr_ranges", () => {
      const config = loadConfig(prod({ AUTH_TRUSTED_PROXIES: "10.0.0.0/8, 192.168.1.1" }));
      expect(config.auth.trustedProxies).toEqual(["10.0.0.0/8", "192.168.1.1"]);
    });

    it("rejects_a_malformed_proxy_entry_instead_of_silently_dropping_it", () => {
      // better-auth 会把解析不了的条目过滤掉，结果又是共享桶——且不报任何错
      let message = "";
      try {
        loadConfig(prod({ AUTH_TRUSTED_PROXIES: "10.0.0.0/8, not-an-ip" }));
      } catch (error) {
        message = error instanceof Error ? error.message : "";
      }
      expect(message).toMatch(/AUTH_TRUSTED_PROXIES/);
      expect(message).toContain("not-an-ip");
      expect(message).not.toContain("10.0.0.0/8");
    });

    it("rejects_an_out_of_range_cidr_prefix", () => {
      expect(() => loadConfig(prod({ AUTH_TRUSTED_PROXIES: "10.0.0.0/99" }))).toThrow(
        /AUTH_TRUSTED_PROXIES/,
      );
    });
  });

  describe("origin and base url must carry an http(s) scheme", () => {
    // zod 的 .url() 认 new URL("localhost:3000") 合法（protocol 变成 "localhost:"），
    // 于是漏写 scheme 能通过启动校验，运行期 CORS 静默不回显 allow-origin，浏览器侧全挂。
    it.each(["localhost:3000", "ftp://app.example.com", "javascript:alert(1)"])(
      "rejects AUTH_TRUSTED_ORIGINS=%s",
      (origin) => {
        expect(() => loadConfig(env({ AUTH_TRUSTED_ORIGINS: origin }))).toThrow(
          /AUTH_TRUSTED_ORIGINS/,
        );
      },
    );

    it("rejects_a_bad_entry_even_when_other_entries_are_fine", () => {
      expect(() =>
        loadConfig(env({ AUTH_TRUSTED_ORIGINS: "https://app.example.com, localhost:3000" })),
      ).toThrow(/localhost:3000/);
    });

    it("accepts_http_and_https_origins", () => {
      const config = loadConfig(
        env({ AUTH_TRUSTED_ORIGINS: "http://localhost:3000, https://app.example.com" }),
      );
      expect(config.auth.trustedOrigins).toEqual([
        "http://localhost:3000",
        "https://app.example.com",
      ]);
    });

    it.each(["localhost:3001", "ftp://api.example.com"])("rejects BETTER_AUTH_URL=%s", (url) => {
      // baseURL 的 scheme 决定 cookie 的 Secure 标志，漏写 scheme 比 origins 更危险
      expect(() => loadConfig(env({ BETTER_AUTH_URL: url }))).toThrow(/BETTER_AUTH_URL/);
    });

    it("accepts_an_https_base_url", () => {
      expect(loadConfig(env({ BETTER_AUTH_URL: "https://api.example.com" })).auth.baseUrl).toBe(
        "https://api.example.com",
      );
    });
  });

  it("turns_on_cross_site_cookie_attributes_only_when_asked", () => {
    expect(loadConfig(env()).auth.crossSiteCookies).toBe(false);
    expect(loadConfig(env({ AUTH_COOKIE_CROSS_SITE: "true" })).auth.crossSiteCookies).toBe(true);
  });

  it("rejects_a_non_boolean_cross_site_flag_rather_than_reading_it_as_false", () => {
    expect(() => loadConfig(env({ AUTH_COOKIE_CROSS_SITE: "yes" }))).toThrow(
      /AUTH_COOKIE_CROSS_SITE/,
    );
  });

  it("exposes_rate_limit_settings_with_safe_defaults", () => {
    const config = loadConfig(env());
    expect(config.rateLimit.windowSeconds).toBeGreaterThan(0);
    expect(config.rateLimit.max).toBeGreaterThan(0);
  });

  it("rejects_a_non_positive_rate_limit_budget", () => {
    expect(() => loadConfig(env({ API_RATE_LIMIT_MAX: "0" }))).toThrow(/API_RATE_LIMIT_MAX/);
  });
});
