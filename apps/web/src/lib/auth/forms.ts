import { z } from "zod";

/**
 * 表单校验 schema。**只为体验服务**，安全以后端为准（web-frontend skill 步骤 4）。
 *
 * 之所以值得在前端也拦一道：api 对 sign-in / sign-up 的限流是每 IP 每 10 秒 3 次，
 * 一次"密码写太短"的往返就白白吃掉三分之一额度，用户很容易把自己锁住。
 */

/** 与 apps/api 的 better-auth `emailAndPassword` 配置保持一致。 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

const emailField = z
  .string()
  .trim()
  .min(1, { message: "请输入邮箱" })
  .email({ message: "邮箱格式不正确" });

export const signInSchema = z.object({
  email: emailField,
  // 登录不校验长度：密码规则以后收紧时，老用户的合法旧密码不该被前端拦下来，
  // 该由后端判定；前端只保证不发空请求。
  password: z.string().min(1, { message: "请输入密码" }),
});

export type SignInInput = z.infer<typeof signInSchema>;

export const signUpSchema = z.object({
  name: z.string().trim().min(1, { message: "请输入姓名" }),
  email: emailField,
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, { message: `密码至少 ${PASSWORD_MIN_LENGTH} 位` })
    .max(PASSWORD_MAX_LENGTH, { message: `密码最多 ${PASSWORD_MAX_LENGTH} 位` }),
});

export type SignUpInput = z.infer<typeof signUpSchema>;

/** zod 的 issue 列表摊平为「字段名 → 首条错误」，供表单逐字段渲染。 */
export const fieldErrorsOf = (error: z.ZodError): Record<string, string> => {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === "string" && errors[field] === undefined) {
      errors[field] = issue.message;
    }
  }
  return errors;
};
