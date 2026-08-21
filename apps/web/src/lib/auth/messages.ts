import type { AuthFailure } from "./failure";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./forms";

/**
 * 失败分支 → 用户可见文案的唯一映射点。文案集中在这里而不是散在组件里，
 * 便于统一措辞与后续国际化（web-frontend skill 最佳实践）。
 *
 * 两条硬性约束：
 * 1. 不渲染后端返回的 message——避免内部措辞泄漏，也保证文案可控；
 * 2. 凭证错不区分"账号不存在"与"密码错"，与 api 侧的刻意合并保持一致（security.md）。
 */

export const rateLimitMessage = (secondsRemaining: number): string =>
  secondsRemaining > 0
    ? `操作过于频繁，请在 ${secondsRemaining} 秒后重试。`
    : "已经可以重试了，请重新提交。";

export const authFailureMessage = (failure: AuthFailure): string => {
  switch (failure.kind) {
    case "invalid-input":
      switch (failure.code) {
        case "PASSWORD_TOO_SHORT":
          return `密码至少 ${PASSWORD_MIN_LENGTH} 位，请换一个更长的密码。`;
        case "PASSWORD_TOO_LONG":
          return `密码最多 ${PASSWORD_MAX_LENGTH} 位，请换一个更短的密码。`;
        case "VALIDATION_ERROR":
        case "BAD_REQUEST":
          return "填写的信息不符合要求，请检查后重试。";
      }
      break;
    case "invalid-credentials":
      return "邮箱或密码不正确。";
    case "email-taken":
      return "该邮箱已被注册，请换一个邮箱或直接登录。";
    case "unauthenticated":
      return "登录状态已失效，请重新登录。";
    case "rate-limited":
      return rateLimitMessage(failure.retryAfterSeconds);
    case "forbidden":
      // 一般是部署配置问题（Origin 不在 api 的白名单里），用户自己修不了。
      return "请求被服务端拒绝，请联系管理员或稍后重试。";
    case "server":
      // 500 对客户端完全不可区分（api 的错误响应不含任何内部信息），
      // 因此不暴露状态码，一律按"稍后重试"处理。
      return "服务暂时不可用，请稍后重试。";
    case "network":
      return "网络连接失败，请检查网络后重试。";
    case "unexpected":
      return "出现未知问题，请稍后重试。";
  }

  // 新增 failure 分支却忘了配文案时，这里会在编译期报错。
  const exhaustive: never = failure;
  return exhaustive;
};
