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
// `apiErrorSchema` 不是一回事——客户端调 `/api/auth/*` 用这个解析，调 `/api/me` 之类
// 本仓库自有端点用 `apiErrorSchema`。
//
// `code` 是可选的：登录失败是 `{message, code:"INVALID_EMAIL_OR_PASSWORD"}`，
// 但限流的 429 只有 `{message}` 没有 code——客户端不能假设 code 一定存在。
export const betterAuthErrorSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
});

export type BetterAuthError = z.infer<typeof betterAuthErrorSchema>;
