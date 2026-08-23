import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
// 跨模块只 import 对方的公开入口（architecture.md）：这里只为声明外键指向用户身份，
// 不查 auth 的任何表——用户数据一律走 auth 模块的公开 service。
import { userTable } from "../auth/index.js";

// ⚠️ **列名 snake_case，TS 属性名 camelCase**。这不是随手选的，两侧的差异有来源：
// auth 那几张表（user / session / account…）的列名是 camelCase，唯一原因是 better-auth
// 按字段名读写、我们没得选；**自有表一律跟 Postgres 惯例走 snake_case**，先例与完整理由见
// `src/shared/rate-limit.schema.ts` 顶部那段注释。task 是自有表，没有任何东西逼它 camelCase，
// 所以别照着隔壁 auth/schema.ts 抄命名。
// 对外契约不受影响：JSON 字段名仍是 `createdAt` 等 camelCase（见 packages/contracts），
// 列名客户端看不到。
//
// 查询路径 → 索引（database-design 步骤 1/3）。本切片只有一条：
//   按 user_id 取自己的任务，按 (created_at, id) 倒序 keyset 翻页
//   → task_user_id_created_at_id_idx
// 没有别的读路径，所以不建别的索引（每个索引都是写入成本）。
// ⚠️ **精度必须是毫秒（`timestamptz(3)`），不能用默认的微秒**，这是正确性问题不是存储优化：
// 游标编码走 `Date.toISOString()`，只有毫秒、而且是**截断**不是四舍五入。列比游标精确时，
// 同一毫秒内的两条记录会让 keyset 上界被截到 `.xxx000`，真实值大于它的那条在之后**任何一页
// 都不会再出现**——永久漏记录，而且没有任何报错。
// 实测（列为微秒时）：6 条时间戳落在 3 个毫秒里的任务，limit=1 翻完全部页面只走到 3 条。
//
// 选毫秒列而不是让游标走全精度：`Date` 往返无损，索引与 keyset 谓词一个字都不用改。代价是
// 同毫秒创建的两条不再有亚毫秒先后、由 `id` 决胜——分页正确性只要求两侧对**同一个全序**达成
// 一致，任务列表不需要亚毫秒的创建时间分辨率。
// 由 task.integration.test.ts 的 stores_created_at_at_millisecond_precision_so_a_cursor_can
// _address_it_exactly（钉列本身）与 walks_every_row_exactly_once_when_timestamps_carry_sub
// _millisecond_precision（钉行为）两条守住。
const MILLISECOND_PRECISION = 3;

const createdAt = timestamp("created_at", {
  withTimezone: true,
  precision: MILLISECOND_PRECISION,
})
  .notNull()
  .defaultNow();
// updated_at 跟着一起改精度：两列语义同源，留一个微秒一个毫秒只会让下一个人以为有讲究
const updatedAt = timestamp("updated_at", {
  withTimezone: true,
  precision: MILLISECOND_PRECISION,
})
  .notNull()
  .defaultNow();

export const task = pgTable(
  "task",
  {
    id: text("id").primaryKey(),
    // 归属列。on delete cascade：用户注销时任务一起走，不留孤儿行
    userId: text("user_id")
      .notNull()
      .references(() => userTable.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    createdAt,
    // 本切片没有任何更新路径，所以 updated_at 恒等于 created_at，也**不出现在对外契约里**
    // （见 packages/contracts 的说明）。列先建好，等状态/编辑切片来用；那个切片必须自己负责
    // 维护这一列（应用层写或加触发器），别假设它已经是"最后修改时间"。
    updatedAt,
  },
  (table) => [
    // 排序方向写进索引，ORDER BY created_at DESC, id DESC 才能直接走索引正扫、不带 Sort 节点
    // （keyset 翻页的每一页都走这条路径）。
    //
    // ⚠️ `nullsFirst()` 不是可省的装饰：drizzle 的 `.desc()` 默认生成 `DESC NULLS LAST`，
    // 而 Postgres 里 `ORDER BY x DESC` 的隐含含义是 `DESC NULLS FIRST`。两者不一致时索引
    // **无法满足排序**——planner 照样会按 user_id 用上这个索引，然后在它上面再加一个 Sort，
    // 把该用户的全部任务排一遍才取 21 行（实测 40k 行：不加 nullsFirst 是
    // `Limit -> Sort -> Bitmap Heap Scan`，cost 5828；加了是干净的 `Index Scan`，cost 4.74）。
    // 两列都是 NOT NULL，所以改的只是排序声明，语义完全不变。
    index("task_user_id_created_at_id_idx").on(
      table.userId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
  ],
);
