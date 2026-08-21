import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, createPool, type Db } from "./db.js";
import { loadConfig } from "./env.js";
import {
  describeError,
  installConsoleRedaction,
  type RedactableConsole,
  redactLogArg,
} from "./log-redaction.js";

// 这些用例用**真实触发的**错误对象，不用手工构造的假错误：上一轮就是因为假错误
// （手填 name: "DrizzleQueryError"）与真实形状不一致，测试绿但承诺没兑现。
const config = loadConfig();
const pool: Pool = createPool(config.db);
const db: Db = createDb(pool);

const SECRET = "victim@example.test";

/** 真实跑一条会失败的查询，拿到真的 DrizzleQueryError（绑定参数里带敏感值）。 */
const realQueryError = async (): Promise<unknown> => {
  try {
    await db.execute(sql`select 1 from "no_such_table_here" where "email" = ${SECRET}`);
  } catch (error) {
    return error;
  }
  throw new Error("expected the query to fail");
};

afterAll(async () => {
  await pool.end();
});

describe("describeError on a real driver error", () => {
  it("carries the sensitive value in the raw error, which is what we must not log", async () => {
    // 先证明这个错误确实是"危险的"，否则下面的断言是废的
    const error = await realQueryError();
    expect(error).toBeInstanceOf(Error);
    const raw =
      error instanceof Error ? `${error.message} ${JSON.stringify(Object.keys(error))}` : "";
    expect(raw).toContain(SECRET);
  });

  it("keeps no value from the error, its own properties, or its cause chain", async () => {
    const serialized = JSON.stringify(describeError(await realQueryError()));

    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("no_such_table_here");
    expect(serialized).not.toContain("select");
  });

  it("still says what broke, so ops can tell a dead database from a code bug", async () => {
    const described = describeError(await realQueryError());

    expect(described.name).toBe("DrizzleQueryError");
    // 42P01 = undefined_table。pg 的错误码是结构化常量，不是用户数据
    expect(described.cause?.name).toBe("DatabaseError");
    expect(described.cause?.code).toBe("42P01");
  });

  it("surfaces the postgres code for a statement timeout, the most common db incident", async () => {
    // 超时是"数据库被锁住/变慢"这类事故的主要表现。客户端超时抢先触发时抛的是
    // 没有任何结构化字段的裸 Error，所以连接池特意让服务端超时先返回（见 db.ts）。
    const slowPool = createPool({ ...config.db, statementTimeoutMs: 300 });
    try {
      const slowDb = createDb(slowPool);
      let described: ReturnType<typeof describeError> | undefined;
      try {
        await slowDb.execute(sql`select pg_sleep(3)`);
      } catch (error) {
        described = describeError(error);
      }

      expect(described?.name).toBe("DrizzleQueryError");
      // 57014 = query_canceled
      expect(described?.cause?.code).toBe("57014");
    } finally {
      await slowPool.end();
    }
  });

  it("stops walking a cause chain that loops or runs deep", () => {
    const first = new Error("a");
    const second = new Error("b", { cause: first });
    Object.defineProperty(first, "cause", { value: second });

    expect(() => JSON.stringify(describeError(second))).not.toThrow();
  });
});

describe("redactLogArg", () => {
  it("lets our own preformatted strings through untouched", () => {
    const line = JSON.stringify({ msg: "api listening", port: 3001 });
    expect(redactLogArg(line)).toBe(line);
  });

  it("reduces any plain object to its type name", () => {
    expect(redactLogArg({ email: SECRET, token: "abc" })).toBe("[Object]");
  });

  it("leaves primitives alone", () => {
    expect(redactLogArg(3001)).toBe(3001);
    expect(redactLogArg(null)).toBe(null);
    expect(redactLogArg(undefined)).toBe(undefined);
  });
});

describe("installConsoleRedaction", () => {
  it("scrubs an error handed straight to console.error, the way better-call does it", async () => {
    const error = await realQueryError();
    const captured: string[] = [];
    const sink = (...args: unknown[]): void => {
      captured.push(args.map((arg) => JSON.stringify(arg) ?? String(arg)).join(" "));
    };

    // 装一个只有 sink 的假 console，验证防护本身，不污染真实 console
    const fake: RedactableConsole = {
      error: sink,
      warn: sink,
      log: sink,
      info: sink,
      debug: sink,
      trace: sink,
      dir: sink,
    };
    const restore = installConsoleRedaction(fake);
    try {
      fake.error("# SERVER_ERROR: ", error);
      fake.dir(error);
    } finally {
      restore();
    }

    expect(captured).toHaveLength(2);
    expect(captured.join("\n")).not.toContain(SECRET);
    expect(captured.join("\n")).toContain("DrizzleQueryError");
  });

  it("restores the original methods so it cannot leak across a process", () => {
    const sink = (): void => {};
    const fake: RedactableConsole = {
      error: sink,
      warn: sink,
      log: sink,
      info: sink,
      debug: sink,
      trace: sink,
      dir: sink,
    };
    const restore = installConsoleRedaction(fake);
    expect(fake.error).not.toBe(sink);
    restore();
    expect(fake.error).toBe(sink);
  });
});
