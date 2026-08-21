import { describe, expect, it } from "vitest";
import { createAuthLogger } from "./logger.js";

const SECRET = "fDmcrcCaM0cro3n0JJOd82lpCv2YBLH7";

/** 仿造 drizzle 的查询错误：绑定参数同时藏在 message、自有属性和 cause 链里。 */
const makeQueryError = (): Error =>
  Object.assign(new Error(`Failed query: select "token" from "session" where "token" = $1`), {
    name: "DrizzleQueryError",
    query: 'select "token" from "session" where "token" = $1',
    params: [SECRET],
    cause: new Error(`bind parameter ${SECRET}`),
  });

const capture = (): { lines: string[]; logger: ReturnType<typeof createAuthLogger> } => {
  const lines: string[] = [];
  return { lines, logger: createAuthLogger((line) => lines.push(line)) };
};

describe("createAuthLogger", () => {
  it("never_emits_values_carried_by_a_library_error", () => {
    const { lines, logger } = capture();

    logger.log("error", "INTERNAL_SERVER_ERROR", makeQueryError());
    const out = lines.join("\n");

    // 不是针对 token 特判：错误里**任何**携带值的部分都不该出现
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("select");
    expect(out).not.toContain("bind parameter");
  });

  it("still_keeps_enough_to_locate_the_failure", () => {
    const { lines, logger } = capture();

    logger.log("error", "INTERNAL_SERVER_ERROR", makeQueryError());
    const out = lines.join("\n");

    // 脱敏不能脱成一片空白，否则线上无从定位
    expect(out).toContain("INTERNAL_SERVER_ERROR");
    expect(out).toContain("DrizzleQueryError");
    expect(out).toContain('"level":"error"');
  });

  it("does_not_emit_values_carried_by_non_error_args", () => {
    const { lines, logger } = capture();

    logger.log("warn", "SOMETHING", { token: SECRET }, SECRET, [SECRET]);
    const out = lines.join("\n");

    expect(out).not.toContain(SECRET);
    expect(out).toContain("SOMETHING");
  });

  it("emits_one_json_line_per_call_so_log_pipelines_can_parse_it", () => {
    const { lines, logger } = capture();

    logger.log("info", "hello");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      msg: "better-auth",
      level: "info",
      detail: "hello",
    });
  });
});
