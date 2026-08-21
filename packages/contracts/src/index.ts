import { z } from "zod";

// 全局统一错误响应格式（见 .claude/skills/api-design SOP 步骤 3）。
// 所有端（web/ios/api/worker）以本包为契约唯一来源。
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(z.unknown()).default([]),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

// ── 认证 ────────────────────────────────────────────────────────────────────
// 对外暴露的用户字段白名单：数据库模型（含 password hash 等）禁止直接序列化。
export const authUserSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  name: z.string(),
  emailVerified: z.boolean(),
  image: z.string().url().nullable(),
  createdAt: z.string().datetime(),
});

export type AuthUser = z.infer<typeof authUserSchema>;

export const meResponseSchema = z.object({
  user: authUserSchema,
});

export type MeResponse = z.infer<typeof meResponseSchema>;

// better-auth 自带路由（`/api/auth/*`）的错误响应形状。它由库定义，与本仓库自有端点的
// `apiErrorSchema` 不是一回事——调 `/api/auth/*` 用这个解析，调 `/api/me` 之类自有端点
// 用 `apiErrorSchema`。
//
// `code` 是**可选**的：绝大多数分支有 code，但 better-auth 的限流响应只有 message。
// 客户端不能假设 code 一定存在。
//
// 实测到的全部分支（apps/api 集成测试逐个打过；两种 429 的重试头名字不一样，别漏）：
//
// | 场景                     | status | code                                    | 头                  |
// |--------------------------|--------|-----------------------------------------|---------------------|
// | 字段缺失 / 邮箱格式错    | 400    | VALIDATION_ERROR                        | —                   |
// | 密码过短（< 12）         | 400    | PASSWORD_TOO_SHORT                      | —                   |
// | 密码过长（> 128）        | 400    | PASSWORD_TOO_LONG                       | —                   |
// | 请求体不是 JSON          | 400    | BAD_REQUEST                             | —                   |
// | 密码错 / 账号不存在      | 401    | INVALID_EMAIL_OR_PASSWORD               | —（两者响应完全相同）|
// | 不可信 Origin            | 403    | INVALID_ORIGIN                          | —                   |
// | 重复邮箱                 | 422    | USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL   | —                   |
// | better-auth 限流         | 429    | （无 code）                              | `X-Retry-After: 10` |
//
// 自有端点（`apiErrorSchema`）对照：
// | 未登录                   | 401    | UNAUTHENTICATED                         | —                   |
// | 限流                     | 429    | RATE_LIMITED                            | `Retry-After: 60`   |
// | 请求体过大               | 413    | PAYLOAD_TOO_LARGE                       | —                   |
// | 路由不存在               | 404    | NOT_FOUND                               | —                   |
//
// 两个 Retry-After 头都在 CORS 的 `Access-Control-Expose-Headers` 里，浏览器读得到。
export const betterAuthErrorSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
});

export type BetterAuthError = z.infer<typeof betterAuthErrorSchema>;
