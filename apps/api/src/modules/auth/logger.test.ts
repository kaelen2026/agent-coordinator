import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, createPool, type Db } from "../../shared/db.js";
import { loadConfig } from "../../shared/env.js";
import { createAuthLogger } from "./logger.js";

// 用**真实触发**的错误，不用手工构造的假错误：上一轮的假错误手填了
// `name: "DrizzleQueryError"`，而真实对象的类型名要从 constructor 上取，
// 结果单测绿、线上拿到的却是 causes:["Error"]，承诺没兑现。
const config = loadConfig();
const pool: Pool = createPool(config.db);
const db: Db = createDb(pool);

const SECRET = "logger-victim@example.test";

const realQueryError = async (): Promise<unknown> => {
  try {
    await db.execute(sql`select 1 from "no_such_table_here" where "email" = ${SECRET}`);
  } catch (error) {
    return error;
  }
  throw new Error("expected the query to fail");
};

const capture = (): { lines: string[]; logger: ReturnType<typeof createAuthLogger> } => {
  const lines: string[] = [];
  return { lines, logger: createAuthLogger((line) => lines.push(line)) };
};

afterAll(async () => {
  await pool.end();
});

describe("createAuthLogger", () => {
  it("never emits values carried by a real driver error", async () => {
    const { lines, logger } = capture();

    logger.log("error", "INTERNAL_SERVER_ERROR", await realQueryError());
    const out = lines.join("\n");

    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("params:");
    expect(out).not.toContain("no_such_table_here");
  });

  it("reports the real error type and postgres error code", async () => {
    const { lines, logger } = capture();

    logger.log("error", "INTERNAL_SERVER_ERROR", await realQueryError());
    const out = lines.join("\n");

    // 这三样才是排障要的：库自己的 message + 真实类型链 + 结构化错误码
    expect(out).toContain("INTERNAL_SERVER_ERROR");
    expect(out).toContain("DrizzleQueryError");
    expect(out).toContain("DatabaseError");
    expect(out).toContain("42P01");
  });

  it("reduces object and array args to their type name", () => {
    const { lines, logger } = capture();

    logger.log("warn", "SOMETHING", { token: SECRET }, [SECRET]);
    const out = lines.join("\n");

    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("token");
    expect(out).toContain("SOMETHING");
  });

  it("emits one json line per call so log pipelines can parse it", () => {
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
