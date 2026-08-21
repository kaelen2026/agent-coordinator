import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, user } from "./modules/auth/schema.js";
import { createDb, createPool, type Db } from "./shared/db.js";
import { loadConfig } from "./shared/env.js";

/**
 * 唯一一个真正起进程的用例，为的是堵住一个测试替代不了的缺口：
 * 其他用例都是自己调 `installConsoleRedaction()` 再断言，这只能证明**机制**有效，
 * 证明不了 `src/index.ts` 真的装了它——把入口那一行删掉，那些用例照样全绿。
 *
 * 这里直接起真实入口、真实制造数据库故障、抓进程的 stdout/stderr，
 * 断言禁列里的东西一个都没出现。等价于评审给的最小复现，只是自动化了。
 */
const PORT = 3199;
const BASE = `http://localhost:${PORT}`;
const ORIGIN = "http://localhost:3000";
const PASSWORD = "correct-horse-battery-staple";

const config = loadConfig();
const pool: Pool = createPool(config.db);
const db: Db = createDb(pool);

let child: ChildProcess | undefined;
let output = "";

const waitForListening = async (): Promise<void> => {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (output.includes('"api listening"')) {
      return;
    }
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`api exited early (${child.exitCode}):\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`api did not start in time:\n${output}`);
};

beforeAll(async () => {
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      PORT: String(PORT),
      BETTER_AUTH_URL: BASE,
      AUTH_TRUSTED_ORIGINS: ORIGIN,
      AUTH_TRUSTED_PROXIES: "none",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });
  await waitForListening();
}, 30_000);

afterAll(async () => {
  child?.kill("SIGKILL");
  await db.execute(sql`alter table if exists "user_e2e_fault" rename to "user"`);
  await pool.end();
});

describe("the real process entry", () => {
  it("keeps credentials out of its own output when the database fails", async () => {
    const email = `e2e-${crypto.randomUUID()}@example.test`;

    const signUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ name: "E2E", email, password: PASSWORD }),
    });
    expect(signUp.status).toBe(200);

    const [owner] = await db.select().from(user).where(eq(user.email, email));
    const [credential] = await db
      .select()
      .from(account)
      .where(eq(account.userId, owner?.id ?? ""));
    const hash = credential?.password ?? "";
    expect(hash.length).toBeGreaterThan(16);

    output = "";
    await db.execute(sql`alter table "user" rename to "user_e2e_fault"`);
    let status = 0;
    try {
      const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({ email, password: PASSWORD }),
      });
      status = res.status;
    } finally {
      await db.execute(sql`alter table if exists "user_e2e_fault" rename to "user"`);
    }
    // 给子进程一点时间把日志刷出来
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(status).toBe(500);
    // 确实记了东西，否则下面的"没有敏感值"是废断言
    expect(output).not.toBe("");

    for (const [label, secret] of [
      ["email", email],
      ["password", PASSWORD],
      ["password hash", hash],
    ] as const) {
      expect(`${label} in process output: ${output.includes(secret)}`).toBe(
        `${label} in process output: false`,
      );
    }
    expect(output).not.toContain("params:");

    // 仍然看得出是数据库炸了
    expect(output).toContain("42P01");

    await db.delete(user).where(eq(user.email, email));
  });
});
