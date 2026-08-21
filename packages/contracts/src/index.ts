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
