import { describe, expect, it } from "vitest";
import { formatDateTime } from "./format";

describe("formatDateTime", () => {
  it("把契约里的 ISO 时间戳渲染成人读得懂的本地时间", () => {
    expect(formatDateTime("2026-08-21T07:48:44.808Z", "UTC")).toBe("2026-08-21 07:48");
  });

  it("按给定时区换算", () => {
    expect(formatDateTime("2026-08-21T07:48:44.808Z", "Asia/Shanghai")).toBe("2026-08-21 15:48");
  });

  it("解析不出来的值原样返回，不显示 Invalid Date，也不抛异常", () => {
    expect(formatDateTime("not-a-date", "UTC")).toBe("not-a-date");
    expect(formatDateTime("", "UTC")).toBe("");
  });
});
