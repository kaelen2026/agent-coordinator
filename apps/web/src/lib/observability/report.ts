import type { AuthFailure } from "../auth/failure";

/**
 * 前端错误上报的唯一出口。
 *
 * 为什么需要它：api 侧的 500 对客户端完全不可区分（错误响应刻意不含任何内部信息），
 * 前端若也不记录，联调时两边都是黑的。这里留一个稳定的埋点位，
 * 将来接真实上报服务只改这一个函数。
 *
 * 只允许记录**操作名 + 失败分类 + 状态码**。邮箱、密码、会话 token 一律不进上报
 * （security.md：日志禁止输出凭证与可识别个人信息）。
 */

export type AuthOperation = "sign-in" | "sign-up" | "sign-out" | "me" | "session";

/** 用户自己造成的失败（密码打错、邮箱占用、被限流）不是故障，报了只会淹没真告警。 */
const EXPECTED_KINDS: AuthFailure["kind"][] = [
  "invalid-input",
  "invalid-credentials",
  "email-taken",
  "unauthenticated",
  "rate-limited",
];

const statusOf = (failure: AuthFailure): number | undefined =>
  failure.kind === "server" || failure.kind === "unexpected" ? failure.status : undefined;

export const reportAuthFailure = (operation: AuthOperation, failure: AuthFailure): void => {
  if (EXPECTED_KINDS.includes(failure.kind)) return;

  console.error("[auth] request failed", {
    operation,
    kind: failure.kind,
    status: statusOf(failure),
  });
};
