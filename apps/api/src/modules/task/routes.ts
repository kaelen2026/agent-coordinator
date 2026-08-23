import {
  type CreateTaskResponse,
  createTaskRequestSchema,
  type TaskListResponse,
} from "@agent-coordinator/contracts";
import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../../shared/errors.js";
import { type AuthEnv, type ReadSession, requireAuth } from "../auth/index.js";
import { createTask, listTasks, type TaskDeps } from "./service.js";

// 路由层只做三件事：解析输入 → 调 service → 序列化输出。业务判断全在 service。

export type TaskRoutesDeps = TaskDeps & { readSession: ReadSession };

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * 查询串同样是不可信外部输入，先校验再用（security.md）。
 * `limit` 用 coerce：查询串里一切都是字符串，但 `"1.5"` / `"abc"` / `"0"` 必须落到 400，
 * 不能被静默夹成边界值——客户端算错了页大小应该知道。
 */
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().min(1).max(256).nullish(),
});

/** zod 报错转 400：只带字段名与原因，不回显收到的值（外部输入不反射进响应）。 */
const toValidationError = (error: z.ZodError): AppError =>
  new AppError(
    400,
    "VALIDATION_ERROR",
    "request failed validation",
    error.issues.map((issue) => ({
      field: issue.path.join(".") || "(body)",
      message: issue.message,
    })),
  );

const parseWith = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw toValidationError(parsed.error);
  }
  return parsed.data;
};

/** 请求体不是 JSON 也是调用方错误（400），不是 500。 */
const readJsonBody = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    throw new AppError(400, "VALIDATION_ERROR", "request body must be valid JSON");
  }
};

export const createTaskRoutes = ({ readSession, ...deps }: TaskRoutesDeps) =>
  new Hono<AuthEnv>()
    .post("/api/tasks", requireAuth(readSession), async (c) => {
      const input = parseWith(createTaskRequestSchema, await readJsonBody(c.req.raw));
      const body: CreateTaskResponse = {
        task: await createTask(deps, c.get("authUser").id, input),
      };
      // 201 不带 Location：本切片没有 GET /api/tasks/{id}，指向必然 404 的头比不给更糟
      // （契约里记了理由）。创建结果已在响应体里。
      return c.json(body, 201);
    })
    .get("/api/tasks", requireAuth(readSession), async (c) => {
      const query = parseWith(listQuerySchema, c.req.query());
      const body: TaskListResponse = await listTasks(deps, c.get("authUser").id, {
        limit: query.limit,
        cursor: query.cursor ?? null,
      });
      return c.json(body);
    });
