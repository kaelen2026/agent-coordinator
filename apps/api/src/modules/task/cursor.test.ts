import { describe, expect, it } from "vitest";
import { AppError } from "../../shared/errors.js";
import { decodeTaskCursor, encodeTaskCursor } from "./cursor.js";

// 游标对客户端不透明，但对服务端必须是可逆且严格的：解不开就得报 400，
// 不能静默退回第一页（那会让翻页看起来在无限循环）。

const expectRejected = (raw: string): AppError => {
  let thrown: unknown;
  try {
    decodeTaskCursor(raw);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AppError);
  expect(thrown).toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
  return thrown as AppError;
};

describe("task cursor", () => {
  it("round_trips_a_created_at_and_id_pair", () => {
    const cursor = { createdAt: new Date("2026-08-22T10:11:12.345Z"), id: "b0a1-задача" };

    expect(decodeTaskCursor(encodeTaskCursor(cursor))).toEqual(cursor);
  });

  it("survives_an_id_that_contains_the_internal_separator", () => {
    const cursor = { createdAt: new Date("2026-08-22T10:11:12.345Z"), id: "a|b|c" };

    expect(decodeTaskCursor(encodeTaskCursor(cursor))).toEqual(cursor);
  });

  it("is_url_safe_so_it_can_be_handed_back_as_a_query_parameter_verbatim", () => {
    const encoded = encodeTaskCursor({ createdAt: new Date(0), id: "ÿþý" });

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(encoded)).toBe(encoded);
  });

  it("rejects_a_value_the_client_made_up", () => {
    expectRejected("not-a-cursor");
  });

  it("rejects_an_empty_cursor", () => {
    expectRejected("");
  });

  it("rejects_characters_that_are_not_base64url_at_all", () => {
    expectRejected("%%%");
  });

  it("rejects_a_decodable_payload_that_has_no_separator", () => {
    expectRejected(Buffer.from("2026-08-22T10:00:00.000Z", "utf8").toString("base64url"));
  });

  it("rejects_a_payload_whose_timestamp_is_not_a_timestamp", () => {
    expectRejected(Buffer.from("yesterday|task-1", "utf8").toString("base64url"));
  });

  it("rejects_a_payload_whose_timestamp_is_a_calendar_impossibility", () => {
    expectRejected(Buffer.from("2026-02-31T10:00:00.000Z|task-1", "utf8").toString("base64url"));
  });

  it("rejects_a_timestamp_that_is_not_the_exact_form_this_endpoint_issues", () => {
    // 只接受"我们自己发出去过的那种写法"：秒级精度是合法 ISO 8601，但我们永不生成它，
    // 出现就说明这个游标是客户端自己拼的（而拼游标是契约明令禁止的）。
    expectRejected(Buffer.from("2026-08-22T10:00:00Z|task-1", "utf8").toString("base64url"));
  });

  it("rejects_a_timestamp_whose_fraction_was_truncated_in_transit", () => {
    expectRejected(Buffer.from("2026-08-22T10:00:00.0Z|task-1", "utf8").toString("base64url"));
  });

  it("rejects_a_payload_with_an_empty_id", () => {
    expectRejected(Buffer.from("2026-08-22T10:00:00.000Z|", "utf8").toString("base64url"));
  });

  it("rejects_an_oversized_cursor_before_decoding_it", () => {
    // 查询串不受 bodyLimit 保护，长度上限得自己设，否则解码放大是白送的 CPU
    expectRejected("A".repeat(10_000));
  });

  it("does_not_echo_the_rejected_cursor_back_to_the_caller", () => {
    // 外部输入不反射进响应（security.md）
    const error = expectRejected(Buffer.from("yesterday|secret-id", "utf8").toString("base64url"));

    expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(
      "secret-id",
    );
  });
});
