import { type AuthUser, meResponseSchema } from "@agent-coordinator/contracts";
import { type AuthFailure, classifyApiFailure, networkFailure } from "../auth/failure";
import { API_BASE_URL } from "../env";

/**
 * 本仓库自有端点的请求层。组件不直接 fetch，一切响应在这里过契约 schema 之后
 * 才允许进入类型世界（typescript.md「运行时边界校验」）。
 *
 * 注意与 `/api/auth/*` 的区别：自有端点的错误形状是 `apiErrorSchema`、
 * 限流头是 `Retry-After`（不带 X- 前缀）。归类逻辑见 auth/failure.ts。
 */

export type ApiResult<T> = { ok: true; data: T } | { ok: false; failure: AuthFailure };

/** 取消不是错误：让它继续上抛，由调用方（effect 清理）静默忽略，避免闪一下错误态。 */
const isAbortError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";

/** 响应体可能是网关塞回来的 HTML，解析失败不能把整个页面掀翻。 */
const readJsonBody = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
};

/**
 * 读取当前登录用户。
 *
 * 跨源带 cookie 必须 `credentials: "include"`；会话 cookie 是 HttpOnly 的，
 * 前端拿不到也不需要拿——绝不把任何 token 落进 localStorage。
 */
export const fetchCurrentUser = async (signal?: AbortSignal): Promise<ApiResult<AuthUser>> => {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/me`, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
      // 会话状态每次都要问服务端，缓存住等于登出后还显示着用户信息
      cache: "no-store",
      signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    return { ok: false, failure: networkFailure() };
  }

  const body = await readJsonBody(response);

  if (!response.ok) {
    return {
      ok: false,
      failure: classifyApiFailure({ status: response.status, body, headers: response.headers }),
    };
  }

  const parsed = meResponseSchema.safeParse(body);
  if (!parsed.success) {
    // 2xx 但结构对不上是契约层面的 bug，不能兜底成"看起来正常"
    return { ok: false, failure: { kind: "unexpected", status: response.status } };
  }

  return { ok: true, data: parsed.data.user };
};
