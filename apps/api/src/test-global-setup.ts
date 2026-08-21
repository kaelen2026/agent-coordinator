import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, createPool } from "./shared/db.js";
import "./test-setup.js";

// 集成测试打真实 Postgres（compose.yaml 的 postgres:17-alpine），不 mock 数据库。
// 迁移在整个测试运行前执行一次；drizzle 有 journal，重复执行是幂等的。
export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is required for integration tests. Run `pnpm infra:up` and copy .env.example to .env",
    );
  }

  const pool = createPool({
    url,
    poolMax: 1,
    connectionTimeoutMs: 10_000,
    statementTimeoutMs: 60_000,
  });
  try {
    await migrate(createDb(pool), {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
  } finally {
    await pool.end();
  }
}
