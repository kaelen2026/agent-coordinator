import { authClient } from "./client";
import { type AuthFailure, classifyAuthFailure, networkFailure } from "./failure";
import type { SignInInput, SignUpInput } from "./forms";

/**
 * `/api/auth/*` 的请求层。组件只调这里的三个函数，不直接碰 better-auth 客户端，
 * 于是「错误码 → 用户可见反馈」只有一处映射（web-frontend skill 步骤 3）。
 *
 * 成功时刻意只返回 `{ ok: true }`：sign-in / sign-up 的响应体里带明文 `token`
 * （就是会话 token id），一律不外传、不落盘、不打日志——会话只走 HttpOnly cookie。
 */

export type AuthActionResult = { ok: true } | { ok: false; failure: AuthFailure };

/** better-auth 客户端调用的统一收口：把 `{data, error}` 折叠成本端的失败分类。 */
const runAuthCall = async (
  call: (captureHeaders: (headers: Headers) => void) => Promise<{
    error: { code?: string | undefined; message?: string | undefined; status: number } | null;
  }>,
): Promise<AuthActionResult> => {
  // 限流的等待秒数只在响应头里（X-Retry-After），better-auth 的 error 对象不带它，
  // 所以用 onError 钩子把原始 Response 的头捞出来。
  let responseHeaders = new Headers();
  const captureHeaders = (headers: Headers) => {
    responseHeaders = headers;
  };

  let result: Awaited<ReturnType<typeof call>>;
  try {
    result = await call(captureHeaders);
  } catch {
    // 没拿到响应：断网、DNS、CORS 预检失败
    return { ok: false, failure: networkFailure() };
  }

  const { error } = result;
  if (error === null) return { ok: true };

  return {
    ok: false,
    failure: classifyAuthFailure({
      status: error.status,
      // 运行时边界数据仍然过契约 schema 校验；message 是可选字段，缺失时补空串，
      // 判定依据是 status + code，不依赖 message 内容。
      body: { message: error.message ?? "", code: error.code },
      headers: responseHeaders,
    }),
  };
};

export const signUp = async (input: SignUpInput): Promise<AuthActionResult> =>
  runAuthCall((captureHeaders) =>
    authClient.signUp.email(
      { name: input.name, email: input.email, password: input.password },
      { onError: (context) => captureHeaders(context.response.headers) },
    ),
  );

export const signIn = async (input: SignInInput): Promise<AuthActionResult> =>
  runAuthCall((captureHeaders) =>
    authClient.signIn.email(
      { email: input.email, password: input.password },
      { onError: (context) => captureHeaders(context.response.headers) },
    ),
  );

export const signOut = async (): Promise<AuthActionResult> =>
  runAuthCall((captureHeaders) =>
    // signOut 无请求体，但 fetchOptions 是第二个位置参数，所以第一个位置得占位。
    authClient.signOut({}, { onError: (context) => captureHeaders(context.response.headers) }),
  );
