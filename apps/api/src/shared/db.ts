import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { AppConfig } from "./env.js";
import { describeError } from "./log-redaction.js";

/** 客户端超时比服务端多留的余量，保证服务端的 57014 先返回。 */
const CLIENT_TIMEOUT_MARGIN_MS = 2_000;

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
    // 服务端超时（Postgres 主动中止，回一个带 code=57014 的真错误）
    statement_timeout: config.statementTimeoutMs,
    // 客户端超时只当兜底，留出余量让服务端那条先触发：两者取同一个值时客户端常常
    // 抢先，抛出的是没有任何结构化字段的裸 Error，排障时连"超时"都看不出来。
    query_timeout: config.statementTimeoutMs + CLIENT_TIMEOUT_MARGIN_MS,
  });

  // 空闲连接被服务端掐断会以 'error' 事件抛出，不监听会打挂进程
  pool.on("error", (error) => {
    console.error(JSON.stringify({ msg: "postgres pool error", error: describeError(error) }));
  });

  return pool;
};

export const createDb = (pool: Pool): Db => drizzle(pool);
