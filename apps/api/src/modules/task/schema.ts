import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
// 跨模块只 import 对方的公开入口（architecture.md）：这里只为声明外键指向用户身份，
// 不查 auth 的任何表——用户数据一律走 auth 模块的公开 service。
import { userTable } from "../auth/index.js";

// 查询路径 → 索引（database-design 步骤 1/3）。本切片只有一条：
//   按 userId 取自己的任务，按 (createdAt, id) 倒序 keyset 翻页 → task_userId_createdAt_id_idx
// 没有别的读路径，所以不建别的索引（每个索引都是写入成本）。
//
// 列名用 camelCase 而不是 shared/rate-limit.schema.ts 那种 snake_case：本表的 userId 是指向
// better-auth 那几张 camelCase 表的外键，与外键目标对齐比与另一张自有表对齐更不容易看错。
// 这是切片契约 §5 定的（DDL 与索引名逐字给出），不是随手选的。
const createdAt = timestamp("createdAt", { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow();

export const task = pgTable(
  "task",
  {
    id: text("id").primaryKey(),
    // 归属列。on delete cascade：用户注销时任务一起走，不留孤儿行
    userId: text("userId")
      .notNull()
      .references(() => userTable.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    createdAt,
    // 本切片没有任何更新路径，所以 updatedAt 恒等于 createdAt，也**不出现在对外契约里**
    // （见 packages/contracts 的说明）。列先建好，等状态/编辑切片来用。
    updatedAt,
  },
  (table) => [
    // 排序方向写进索引，ORDER BY createdAt DESC, id DESC 才能直接走索引正扫、不带 Sort 节点
    // （keyset 翻页的每一页都走这条路径）。
    //
    // ⚠️ `nullsFirst()` 不是可省的装饰：drizzle 的 `.desc()` 默认生成 `DESC NULLS LAST`，
    // 而 Postgres 里 `ORDER BY x DESC` 的隐含含义是 `DESC NULLS FIRST`。两者不一致时索引
    // **无法满足排序**——planner 照样会按 userId 用上这个索引，然后在它上面再加一个 Sort，
    // 把该用户的全部任务排一遍才取 21 行（实测 40k 行：不加 nullsFirst 是
    // `Limit -> Sort -> Bitmap Heap Scan`，cost 5828；加了是干净的 `Index Scan`，cost 4.74）。
    // 两列都是 NOT NULL，所以改的只是排序声明，语义完全不变。
    index("task_userId_createdAt_id_idx").on(
      table.userId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
  ],
);
