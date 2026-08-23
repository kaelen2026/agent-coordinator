import { taskListResponseSchema, taskSchema } from "@agent-coordinator/contracts";
import { describe, expect, it } from "vitest";
import { AppError } from "../../shared/errors.js";
import { encodeTaskCursor } from "./cursor.js";
import {
  createTask,
  type ListTasksQuery,
  listTasks,
  type NewTaskRow,
  type TaskDeps,
  type TaskRecord,
} from "./service.js";

// service 层业务规则的单测：不碰 IO，repo 用假实现（真实 SQL 由 task.integration.test.ts
// 打真库覆盖——mock 出来的 SQL 永远是对的，测不出查询错）。

const OWNER = "user-owner";
const OTHER = "user-other";

const at = (iso: string): Date => new Date(iso);

const record = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  id: "task-1",
  title: "ship the slice",
  description: null,
  createdAt: at("2026-08-22T10:00:00.000Z"),
  ...overrides,
});

/** 记录调用参数的假 repo：断言 service 到底把什么条件交给了数据访问层。 */
const fakeRepo = (rows: TaskRecord[] = []) => {
  const inserts: NewTaskRow[] = [];
  const queries: ListTasksQuery[] = [];
  const repo = {
    insert: async (row: NewTaskRow): Promise<TaskRecord> => {
      inserts.push(row);
      return record({ id: row.id, title: row.title, description: row.description });
    },
    listByOwner: async (query: ListTasksQuery): Promise<TaskRecord[]> => {
      queries.push(query);
      return rows.slice(0, query.limit);
    },
  };
  return { repo, inserts, queries };
};

const depsWith = (rows: TaskRecord[] = [], ids: string[] = ["generated-id"]) => {
  const { repo, inserts, queries } = fakeRepo(rows);
  const remaining = [...ids];
  const deps: TaskDeps = { repo, newId: () => remaining.shift() ?? "exhausted" };
  return { deps, inserts, queries };
};

describe("createTask", () => {
  it("returns_a_contract_shaped_task_built_from_the_stored_row", async () => {
    const { deps } = depsWith([], ["task-generated"]);

    const task = await createTask(deps, OWNER, { title: "ship the slice" });

    expect(taskSchema.parse(task)).toEqual({
      id: "task-generated",
      title: "ship the slice",
      description: null,
      createdAt: "2026-08-22T10:00:00.000Z",
    });
  });

  it("stores_the_task_under_the_calling_user_so_it_cannot_be_created_for_someone_else", async () => {
    const { deps, inserts } = depsWith();

    await createTask(deps, OWNER, { title: "mine", description: "d" });

    expect(inserts).toEqual([
      { id: "generated-id", userId: OWNER, title: "mine", description: "d" },
    ]);
  });

  it("uses_the_injected_id_generator_so_ids_are_deterministic_under_test", async () => {
    const { deps } = depsWith([], ["first", "second"]);

    const one = await createTask(deps, OWNER, { title: "a" });
    const two = await createTask(deps, OWNER, { title: "b" });

    expect([one.id, two.id]).toEqual(["first", "second"]);
  });

  it("normalizes_a_missing_description_to_null", async () => {
    const { deps, inserts } = depsWith();

    await createTask(deps, OWNER, { title: "a" });

    expect(inserts[0]?.description).toBeNull();
  });

  it("normalizes_an_explicit_null_description_to_null", async () => {
    const { deps, inserts } = depsWith();

    await createTask(deps, OWNER, { title: "a", description: null });

    expect(inserts[0]?.description).toBeNull();
  });

  it("normalizes_an_empty_description_to_null", async () => {
    const { deps, inserts } = depsWith();

    await createTask(deps, OWNER, { title: "a", description: "" });

    expect(inserts[0]?.description).toBeNull();
  });

  it("normalizes_a_whitespace_only_description_to_null", async () => {
    const { deps, inserts } = depsWith();

    await createTask(deps, OWNER, { title: "a", description: "  \t\n " });

    expect(inserts[0]?.description).toBeNull();
  });

  it("trims_the_surrounding_whitespace_off_a_description_it_keeps", async () => {
    const { deps, inserts } = depsWith();

    await createTask(deps, OWNER, { title: "a", description: "  real text  " });

    expect(inserts[0]?.description).toBe("real text");
  });
});

describe("listTasks", () => {
  const page = [
    record({ id: "c", createdAt: at("2026-08-22T12:00:00.000Z") }),
    record({ id: "b", createdAt: at("2026-08-22T11:00:00.000Z") }),
    record({ id: "a", createdAt: at("2026-08-22T10:00:00.000Z") }),
  ];

  it("returns_a_contract_shaped_page_of_the_callers_tasks", async () => {
    const { deps } = depsWith(page);

    const result = await listTasks(deps, OWNER, { limit: 20, cursor: null });

    const parsed = taskListResponseSchema.parse(result);
    expect(parsed.tasks.map((task) => task.id)).toEqual(["c", "b", "a"]);
    expect(parsed.nextCursor).toBeNull();
  });

  it("scopes_the_query_to_the_calling_user", async () => {
    const { deps, queries } = depsWith(page);

    await listTasks(deps, OTHER, { limit: 20, cursor: null });

    expect(queries[0]?.userId).toBe(OTHER);
  });

  it("asks_the_repository_for_one_extra_row_to_decide_whether_a_next_page_exists", async () => {
    const { deps, queries } = depsWith(page);

    await listTasks(deps, OWNER, { limit: 2, cursor: null });

    expect(queries[0]?.limit).toBe(3);
  });

  it("trims_the_extra_row_off_the_page_and_hands_back_a_cursor_for_the_next_one", async () => {
    const { deps } = depsWith(page);

    const result = await listTasks(deps, OWNER, { limit: 2, cursor: null });

    expect(result.tasks.map((task) => task.id)).toEqual(["c", "b"]);
    expect(result.nextCursor).toBe(
      encodeTaskCursor({ createdAt: at("2026-08-22T11:00:00.000Z"), id: "b" }),
    );
  });

  it("returns_a_null_next_cursor_when_the_last_page_is_exactly_full", async () => {
    // 客户端不能靠 tasks.length === limit 猜"还有下一页"：多取一条才是判据
    const { deps } = depsWith(page);

    const result = await listTasks(deps, OWNER, { limit: 3, cursor: null });

    expect(result.tasks).toHaveLength(3);
    expect(result.nextCursor).toBeNull();
  });

  it("passes_the_decoded_cursor_to_the_repository_as_a_keyset_bound", async () => {
    const { deps, queries } = depsWith(page);
    const cursor = encodeTaskCursor({ createdAt: at("2026-08-22T11:00:00.000Z"), id: "b" });

    await listTasks(deps, OWNER, { limit: 20, cursor });

    expect(queries[0]?.after).toEqual({ createdAt: at("2026-08-22T11:00:00.000Z"), id: "b" });
  });

  it("rejects_a_cursor_it_cannot_decode_instead_of_silently_returning_the_first_page", async () => {
    const { deps, queries } = depsWith(page);

    await expect(listTasks(deps, OWNER, { limit: 20, cursor: "not-a-cursor" })).rejects.toThrow(
      AppError,
    );
    expect(queries).toEqual([]);
  });

  it("reports_an_undecodable_cursor_as_a_400_validation_error", async () => {
    const { deps } = depsWith(page);

    const error = await listTasks(deps, OWNER, { limit: 20, cursor: "%%%" }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
  });
});
