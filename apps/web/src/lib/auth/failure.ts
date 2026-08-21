import { apiErrorSchema, betterAuthErrorSchema } from "@agent-coordinator/contracts";

/**
 * 后端两套错误形状到"用户可见反馈"的唯一归类点。
 *
 * 契约（packages/contracts）里 `/api/auth/*` 用 `betterAuthErrorSchema`、自有端点用
 * `apiErrorSchema`，两者不通用；再加上两种 429 的重试头名字不同。这些差异只在本文件
 * 消化，组件只认下面这组 `AuthFailure`。
 */

/** 读不到重试头时自己的退避值。契约明确说明服务端那些秒数是观测值、不是常量。 */
export const FALLBACK_RETRY_AFTER_SECONDS = 60;

/** 倒计时上限：服务端给出荒谬值时不把用户锁在一个几小时的倒计时里。 */
export const MAX_RETRY_AFTER_SECONDS = 3600;

/** better-auth 的重试头。注意与自有端点的 `Retry-After` 不是同一个名字。 */
const AUTH_RETRY_AFTER_HEADER = "X-Retry-After";
/** 自有端点的重试头。 */
const API_RETRY_AFTER_HEADER = "Retry-After";

/** 归到"字段校验错"的 code。范围之外的 code 一律 unexpected，不冒充已知分支。 */
const INVALID_INPUT_CODES = [
  "VALIDATION_ERROR",
  "PASSWORD_TOO_SHORT",
  "PASSWORD_TOO_LONG",
  "BAD_REQUEST",
] as const;

export type InvalidInputCode = (typeof INVALID_INPUT_CODES)[number];

const isInvalidInputCode = (code: string): code is InvalidInputCode =>
  INVALID_INPUT_CODES.some((known) => known === code);

/**
 * UI 需要区分的失败种类。
 *
 * 刻意**不**携带服务端 message：对外错误文案由本端集中维护（见 messages.ts），
 * 直接渲染后端 message 既会漏出内部措辞，也让文案无法统一。
 * `invalid-credentials` 同样刻意不区分"账号不存在"与"密码错"——api 侧是故意合并的
 * （security.md），UI 跟着合并。
 */
export type AuthFailure =
  | { kind: "invalid-input"; code: InvalidInputCode }
  | { kind: "invalid-credentials" }
  | { kind: "email-taken" }
  | { kind: "unauthenticated" }
  | { kind: "rate-limited"; retryAfterSeconds: number }
  | { kind: "forbidden"; code: string }
  | { kind: "server"; status: number }
  | { kind: "network" }
  | { kind: "unexpected"; status: number };

export type FailureInput = {
  status: number;
  body: unknown;
  headers: Headers;
};

/** 重试头是运行时边界数据：只接受正整数秒，其余一律退避到自己的默认值。 */
const readRetryAfterSeconds = (headers: Headers, headerName: string): number => {
  const raw = headers.get(headerName);
  if (raw === null) return FALLBACK_RETRY_AFTER_SECONDS;

  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return FALLBACK_RETRY_AFTER_SECONDS;

  const seconds = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return FALLBACK_RETRY_AFTER_SECONDS;

  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
};

/** 网络层根本没拿到响应（DNS/断网/CORS 预检失败）——UI 要给重试入口。 */
export const networkFailure = (): AuthFailure => ({ kind: "network" });

/** better-auth 自带路由（`/api/auth/*`）的错误响应归类。 */
export const classifyAuthFailure = ({ status, body, headers }: FailureInput): AuthFailure => {
  if (status === 429) {
    return {
      kind: "rate-limited",
      retryAfterSeconds: readRetryAfterSeconds(headers, AUTH_RETRY_AFTER_HEADER),
    };
  }

  if (status >= 500) return { kind: "server", status };

  // 运行时边界：body 先过契约 schema 才允许进类型世界，解析不出来就降级。
  const parsed = betterAuthErrorSchema.safeParse(body);
  if (!parsed.success) return { kind: "unexpected", status };

  const { code } = parsed.data;
  if (code === undefined) return { kind: "unexpected", status };

  if (status === 400 && isInvalidInputCode(code)) return { kind: "invalid-input", code };
  if (status === 401 && code === "INVALID_EMAIL_OR_PASSWORD")
    return { kind: "invalid-credentials" };
  if (status === 403) return { kind: "forbidden", code };
  if (status === 422 && code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") {
    return { kind: "email-taken" };
  }

  return { kind: "unexpected", status };
};

/** 本仓库自有端点（`/api/me` 等）的错误响应归类。 */
export const classifyApiFailure = ({ status, body, headers }: FailureInput): AuthFailure => {
  if (status === 429) {
    return {
      kind: "rate-limited",
      retryAfterSeconds: readRetryAfterSeconds(headers, API_RETRY_AFTER_HEADER),
    };
  }

  if (status >= 500) return { kind: "server", status };

  const parsed = apiErrorSchema.safeParse(body);
  if (!parsed.success) return { kind: "unexpected", status };

  const { code } = parsed.data.error;
  if (status === 401 && code === "UNAUTHENTICATED") return { kind: "unauthenticated" };
  if (status === 403) return { kind: "forbidden", code };

  return { kind: "unexpected", status };
};
