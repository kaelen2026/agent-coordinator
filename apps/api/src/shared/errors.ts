import type { ApiError } from "@agent-coordinator/contracts";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { describeError } from "./log-redaction.js";

// 业务错误统一从这里抛出，onError 负责映射为契约错误格式。
// code 是对外契约的一部分（客户端只依赖 code），新增时保持稳定命名。
export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details: unknown[] = [],
    /** 附加响应头，如 429 的 Retry-After（api-design：限流必须告诉客户端等多久）。 */
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const body = (code: string, message: string, details: unknown[] = []): ApiError => ({
  error: { code, message, details },
});

export const onError = (err: Error, c: Context): Response => {
  if (err instanceof AppError) {
    return c.json(body(err.code, err.message, err.details), err.status, err.headers);
  }
  if (err instanceof HTTPException) {
    return c.json(body("HTTP_ERROR", err.message), err.status);
  }
  // 未知错误：细节只进日志，不出响应（security.md：错误响应不泄露内部信息）。
  // 连日志里也不放 message/stack——库的错误（如 drizzle）会把绑定参数拼进 message，
  // 那里可能是邮箱、token 或任何字段。只留类型链 + 结构化错误码，够区分故障类型。
  console.error(JSON.stringify({ msg: "unhandled error", error: describeError(err) }));
  return c.json(body("INTERNAL", "internal server error"), 500);
};

export const onNotFound = (c: Context): Response => c.json(body("NOT_FOUND", "no such route"), 404);
