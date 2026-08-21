import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// 本服务自有端点的限流计数。落库而不是进程内存：服务保持无状态、可水平扩展，
// 多实例共享同一份额度（architecture.md）。
//
// 列名用 snake_case——auth 那几张表是 camelCase 因为 better-auth 按字段名读写、
// 我们没得选，自有的表跟 Postgres 惯例走。
//
// 查询路径 → 索引：
//   每个请求按 key 做一次原子 upsert  → 主键
//   定期清理过期窗口                  → api_rate_limit_window_started_at_idx
export const apiRateLimit = pgTable(
  "api_rate_limit",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("api_rate_limit_window_started_at_idx").on(table.windowStartedAt)],
);
