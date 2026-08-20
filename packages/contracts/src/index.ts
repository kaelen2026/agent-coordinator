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
