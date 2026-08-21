import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { AppConfig } from "./env.js";

export type Db = ReturnType<typeof drizzle>;

/**
 * 连接池在进程入口构造一次并注入下游（不在业务代码里 new）。
 * 超时必须显式配置：没有超时的网络调用视为 bug（security.md）。
 */
export const createPool = (config: AppConfig["db"]): Pool => {
  const pool = new Pool({
    connectionString: config.url,
    max: config.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    query_timeout: config.statementTimeoutMs,
  });

  // 空闲连接被服务端掐断会以 'error' 事件抛出，不监听会打挂进程
  pool.on("error", (error) => {
    console.error(JSON.stringify({ msg: "postgres pool error", error: error.message }));
  });

  return pool;
};

export const createDb = (pool: Pool): Db => drizzle(pool);
