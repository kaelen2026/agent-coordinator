import type { CreateTaskRequest, Task, TaskListResponse } from "@agent-coordinator/contracts";
import { decodeTaskCursor, encodeTaskCursor, type TaskCursor } from "./cursor.js";

/**
 * repo 交给 service 的行形状。**不含 `userId`**：归属是查询条件，不是要返回给谁看的数据；
 * 也不含 `updatedAt`——本切片没有更新路径，契约里没有它。
 */
export type TaskRecord = {
  id: string;
  title: string;
  description: string | null;
  createdAt: Date;
};

export type NewTaskRow = {
  id: string;
  userId: string;
  title: string;
  description: string | null;
};

/** `after` 是 keyset 上界（严格小于），null 表示第一页。 */
export type ListTasksQuery = {
  userId: string;
  limit: number;
  after: TaskCursor | null;
};

export type TaskRepo = {
  insert: (row: NewTaskRow) => Promise<TaskRecord>;
  listByOwner: (query: ListTasksQuery) => Promise<TaskRecord[]>;
};

/** 依赖在进程入口构造后注入：id 生成器可替换，测试才能拿到确定的 id。 */
export type TaskDeps = { repo: TaskRepo; newId: () => string };

/**
 * description 的规范化规则：trim 后为空（缺失、null、空串、纯空白）一律存 null。
 *
 * 请求 schema 也 trim，但那是为了让长度上限落在 trim 之后；"空等于没有"是业务规则，
 * 所以判定放在 service——service 被别处调用时同样成立，不依赖调用方先过一遍 schema。
 */
const normalizeDescription = (description: string | null | undefined): string | null => {
  const trimmed = description?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
};

/** 逐字段显式映射为对外白名单，不展开整行——数据库行含 userId / updatedAt。 */
const toTask = (record: TaskRecord): Task => ({
  id: record.id,
  title: record.title,
  description: record.description,
  createdAt: record.createdAt.toISOString(),
});

export const createTask = async (
  deps: TaskDeps,
  userId: string,
  input: CreateTaskRequest,
): Promise<Task> => {
  const record = await deps.repo.insert({
    id: deps.newId(),
    // 归属恒取自当前会话，绝不接受请求体里的 userId（防越权创建）
    userId,
    title: input.title,
    description: normalizeDescription(input.description),
  });

  return toTask(record);
};

export const listTasks = async (
  deps: TaskDeps,
  userId: string,
  query: { limit: number; cursor: string | null },
): Promise<TaskListResponse> => {
  // 先解游标：解不开就不该打数据库（fail fast，非法游标不消耗一次查询）
  const after = query.cursor === null ? null : decodeTaskCursor(query.cursor);

  // 多取一条来判定"还有下一页"。靠 `rows.length === limit` 判的话，最后一页刚好装满时
  // 会返回一个指向空页的 nextCursor，客户端要多跑一次请求才知道到底了。
  const rows = await deps.repo.listByOwner({ userId, limit: query.limit + 1, after });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    tasks: page.map(toTask),
    nextCursor:
      hasMore && last !== undefined
        ? encodeTaskCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  };
};
