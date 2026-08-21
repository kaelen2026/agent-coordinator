import { describe, expect, it } from "vitest";
import { CLIENT_IP_HEADER, resolveClientIp, UNKNOWN_CLIENT_IP } from "./client-ip.js";

const headers = (init: Record<string, string> = {}): Headers => new Headers(init);

describe("resolveClientIp", () => {
  it("uses_the_socket_address_when_no_proxy_is_trusted", () => {
    expect(resolveClientIp(headers(), "203.0.113.7", [])).toBe("203.0.113.7");
  });

  it("ignores_a_forwarded_header_when_no_proxy_is_trusted", () => {
    // 直连暴露时 X-Forwarded-For 完全由客户端控制，信了就等于让攻击者自选限流桶
    const resolved = resolveClientIp(headers({ "x-forwarded-for": "1.2.3.4" }), "203.0.113.7", []);
    expect(resolved).toBe("203.0.113.7");
  });

  it("takes_the_first_untrusted_hop_from_the_right_of_the_forwarded_chain", () => {
    const resolved = resolveClientIp(
      headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.9" }),
      "10.0.0.9",
      ["10.0.0.0/8"],
    );
    expect(resolved).toBe("203.0.113.7");
  });

  it("does_not_let_a_client_prepend_a_fake_hop_to_escape_its_own_bucket", () => {
    // 攻击者伪造 "1.2.3.4" 在链首，真实来源仍是链上第一个不可信跳
    const resolved = resolveClientIp(
      headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.7, 10.0.0.9" }),
      "10.0.0.9",
      ["10.0.0.0/8"],
    );
    expect(resolved).toBe("203.0.113.7");
  });

  it("falls_back_to_the_socket_address_when_the_chain_is_unusable", () => {
    const resolved = resolveClientIp(headers({ "x-forwarded-for": "garbage" }), "10.0.0.9", [
      "10.0.0.0/8",
    ]);
    expect(resolved).toBe("10.0.0.9");
  });

  it("normalizes_ipv6_so_one_client_maps_to_one_bucket", () => {
    expect(resolveClientIp(headers(), "2001:DB8::1", [])).toBe(
      resolveClientIp(headers(), "2001:db8:0:0:0:0:0:1", []),
    );
  });

  it("maps_ipv4_mapped_ipv6_socket_addresses_to_plain_ipv4", () => {
    expect(resolveClientIp(headers(), "::ffff:203.0.113.7", [])).toBe("203.0.113.7");
  });

  it("reports_unknown_when_there_is_no_trustworthy_source_at_all", () => {
    expect(resolveClientIp(headers(), undefined, [])).toBe(UNKNOWN_CLIENT_IP);
  });

  it("exposes_an_internal_header_name_that_is_not_a_standard_forwarding_header", () => {
    // 这个头由信任边界写入并覆盖外部同名头；用标准名会和代理写的头混淆
    expect(CLIENT_IP_HEADER).not.toBe("x-forwarded-for");
    expect(CLIENT_IP_HEADER).not.toBe("x-real-ip");
  });
});
