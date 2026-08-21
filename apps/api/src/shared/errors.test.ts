import { sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createDb, createPool, type Db } from "./db.js";
import { loadConfig } from "./env.js";
import { AppError, onError } from "./errors.js";

const config = loadConfig();
const pool: Pool = createPool(config.db);
const db: Db = createDb(pool);

const SECRET = "onerror-victim@example.test";

/** 真实的 drizzle 查询错误：绑定参数里带敏感值，message 里也带。 */
const realQueryError = async (): Promise<unknown> => {
  try {
    await db.execute(sql`select 1 from "no_such_table_here" where "email" = ${SECRET}`);
  } catch (error) {
    return error;
  }
  throw new Error("expected the query to fail");
};

const runAndCapture = async (thrown: unknown): Promise<{ log: string; body: string }> => {
  const captured: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    captured.push(args.map((arg) => String(arg)).join(" "));
  });
  try {
    const app = new Hono();
    app.onError(onError);
    app.get("/boom", () => {
      throw thrown;
    });
    const res = await app.request("/boom");
    return { log: captured.join("\n"), body: await res.text() };
  } finally {
    spy.mockRestore();
  }
};

afterAll(async () => {
  await pool.end();
});

describe("onError", () => {
  it("never logs the message or stack of a library error", async () => {
    // onError 自己拼好 JSON 字符串再交给 console，console 层的防护看不进字符串内部，
    // 所以这里必须自己脱敏——这正是评审点出的"第二个口子"。
    const { log } = await runAndCapture(await realQueryError());

    expect(log).not.toContain(SECRET);
    expect(log).not.toContain("params:");
    expect(log).not.toContain("no_such_table_here");
  });

  it("still logs enough to identify the failure", async () => {
    const { log } = await runAndCapture(await realQueryError());

    expect(log).toContain("DrizzleQueryError");
    expect(log).toContain("42P01");
  });

  it("never leaks internals into the response body", async () => {
    const { body } = await runAndCapture(await realQueryError());

    expect(body).not.toContain(SECRET);
    expect(body).not.toContain("no_such_table_here");
    expect(JSON.parse(body)).toEqual({
      error: { code: "INTERNAL", message: "internal server error", details: [] },
    });
  });

  it("keeps reporting business errors with their stable code", async () => {
    const { body } = await runAndCapture(new AppError(404, "TASK_NOT_FOUND", "no such task"));

    expect(JSON.parse(body)).toEqual({
      error: { code: "TASK_NOT_FOUND", message: "no such task", details: [] },
    });
  });
});
