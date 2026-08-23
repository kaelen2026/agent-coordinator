import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../../shared/db.js";
import { task } from "./schema.js";
import type { ListTasksQuery, NewTaskRow, TaskRecord, TaskRepo } from "./service.js";

// repo 只做存取：没有业务判断，也不决定"该看谁的数据"——归属条件由 service 传进来。
// 全部走 drizzle 的参数化查询，不拼字符串 SQL（security.md）。

/** 只 select 契约需要的列，不 `select()` 整行（避免以后加了敏感列被顺手带出去）。 */
const columns = {
  id: task.id,
  title: task.title,
  description: task.description,
  createdAt: task.createdAt,
};

export const createTaskRepo = (db: Db): TaskRepo => ({
  insert: async (row: NewTaskRow): Promise<TaskRecord> => {
    const [inserted] = await db.insert(task).values(row).returning(columns);
    if (inserted === undefined) {
      // 单行 INSERT ... RETURNING 不返回行是不该发生的：宁可带上下文快速失败，
      // 也不返回一个编造的行让错误在下游变形（architecture.md fail fast）。
      throw new Error(`insert into task returned no row (userId=${row.userId})`);
    }
    return inserted;
  },

  listByOwner: async ({ userId, limit, after }: ListTasksQuery): Promise<TaskRecord[]> =>
    db
      .select(columns)
      .from(task)
      // 归属过滤：service 传的是当前会话的 userId，这里没有"查全部"的分支
      .where(
        and(
          eq(task.userId, userId),
          // keyset 翻页用行值比较，与 (createdAt DESC, id DESC) 的排序严格对偶：
          // 比 `createdAt < ?` 精确（同一时间戳的并列行靠 id 决胜，不重不漏），
          // 也比 OFFSET 便宜（深翻页不用扫过跳过的行）。
          // 时间戳显式转 timestamptz：行值比较里 PG 推不出参数类型，交给驱动会按 text 比。
          after === null
            ? undefined
            : sql`(${task.createdAt}, ${task.id}) < (${after.createdAt.toISOString()}::timestamptz, ${after.id})`,
        ),
      )
      .orderBy(desc(task.createdAt), desc(task.id))
      .limit(limit),
});
