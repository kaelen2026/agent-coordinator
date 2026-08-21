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
// | **缺失 Origin 头**       | 403    | MISSING_OR_NULL_ORIGIN                  | —                   |
// | 重复邮箱                 | 422    | USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL   | —                   |
// | better-auth 限流         | 429    | （无 code）                              | `X-Retry-After: 10` |
//
// ⚠️ **凡是带凭证的服务端转发，必须显式设 `Origin`**。浏览器 fetch 会自动带，但
// Next.js 的 Server Action / Route Handler / 服务端 `fetch` **默认不带**，从服务端转发
// 登出或任何 `/api/auth/*` 写操作会直接吃 403 `MISSING_OR_NULL_ORIGIN`（实测过）。
// 设的值必须在 api 的 `AUTH_TRUSTED_ORIGINS` 白名单里，否则变成 403 `INVALID_ORIGIN`。
//
// ⚠️ **`/api/auth/*` 的 429 响应头写的是 `content-type: text/plain;charset=UTF-8`，
// 但 body 其实是 JSON**（其余分支都是 `application/json`）。`fetch().json()` 不受影响，
// 但 axios 这类按 content-type 决定解析方式的客户端会拿到字符串，需要自己再 parse。
//
// 自有端点（`apiErrorSchema`）对照：
// | 未登录                   | 401    | UNAUTHENTICATED                         | —                   |
// | 限流                     | 429    | RATE_LIMITED                            | `Retry-After: 60`   |
// | 请求体过大               | 413    | PAYLOAD_TOO_LARGE                       | —                   |
// | 路由不存在               | 404    | NOT_FOUND                               | —                   |
//
// 两个 Retry-After 头都在 CORS 的 `Access-Control-Expose-Headers` 里，浏览器读得到。
//
// ⚠️ 表里的 `10` / `60` 是**当前配置下的观测值，不是常量**——better-auth 对
// sign-in / sign-up 用 10 秒窗口、其他路径 60 秒，自有端点取环境变量
// `API_RATE_LIMIT_WINDOW_SECONDS`。客户端**必须读响应头拿等待时长，不要把数字写死**：
// 自有端点读 `Retry-After`，`/api/auth/*` 读 `X-Retry-After`（注意两者名字不同），
// 都以秒为单位；读不到就退避到自己的默认值，不要假设。
export const betterAuthErrorSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
});

export type BetterAuthError = z.infer<typeof betterAuthErrorSchema>;

// ── 原生客户端的 bearer token 认证 ──────────────────────────────────────────────
//
// web 走 cookie，原生客户端（iOS）走 bearer token：登录/注册的成功响应把会话 token 放在
// 一个响应头里，客户端存进 Keychain，之后每个请求用 `Authorization: Bearer <token>` 发回。
// 服务端由 better-auth 官方 bearer plugin 提供（`apps/api/src/modules/auth/auth.ts`）。
//
// 下面每一条都是 `apps/api/src/modules/auth/auth.integration.test.ts` 逐个实测出来的，
// 不是照文档抄的。客户端不可热修，所以这些行为在 api 侧都有测试钉住——better-auth 升级动了
// 其中任何一条，CI 会先红。
//
// **1. token 从哪里取**
//
// | 端点                              | 成功响应带 `set-auth-token`？ |
// |-----------------------------------|-------------------------------|
// | `POST /api/auth/sign-up/email`    | 是                            |
// | `POST /api/auth/sign-in/email`    | 是                            |
// | `POST /api/auth/sign-out`         | 否（登出不下发新 token）      |
//
// 头名就是 `SESSION_TOKEN_HEADER`（HTTP 头名大小写不敏感，实际下发的是全小写）。
//
// **2. token 长什么样 —— 必须原样透传**
//
// 形状是 `<会话 id>.<HMAC 签名>`，签名是**标准** base64，会出现 `+`、`/` 和末尾的 `=`
// 填充。形如 `XixGaueZNw95NdRyuccugjgQv8i7mXNu.JWMpR42ML44FnfjVvnyku8WrEf2R1Ku05vtuURed9AE=`。
//
// ⚠️ 存取过程中**不要做任何加工**：不要 URL 编解码、不要 trim、不要按 `.` 截断只留前半段。
// 服务端开了 `requireSignature`，只接受带签名的完整 token——把签名去掉、只留裸的会话 id
// 会被当成无效凭证（401）。这是有意的：裸 id 一旦从库/备份/日志漏出来就能冒充用户。
//
// **3. 怎么带、哪些端点接受**
//
// `Authorization: Bearer <token>`。接受范围：
//   - `/api/auth/*` 的全部路由（含 `sign-out`）——bearer plugin 把它翻译成会话 cookie；
//   - 本仓库自有的受保护端点（当前是 `GET /api/me`）——它走 better-auth 的 `getSession`，
//     同一个 plugin 生效。
// 同一个 token 在两类端点上通用，客户端不需要区分。
//
// **4. Origin 要求（原生客户端最容易踩的一条）**
//
// better-auth 的 origin/CSRF 校验只在下面两种情况下真正生效（实测；源码见
// `api/middlewares/origin-check.mjs` 的 `useCookies` 分支）：
//   a. 请求带了 `Cookie` 头 —— 这是 web 的情形，规则一点没变；
//   b. 请求带了 `Origin`（或 `Referer` / `Sec-Fetch-*`）—— 此时 `sign-up` / `sign-in`
//      会**强制**校验它在信任清单里。
// 原生客户端两条都不沾（`URLSession` 默认不发 `Origin`，也不带 cookie），所以：
//
// | iOS 发的 Origin                      | sign-up / sign-in    | sign-out（bearer） | `GET /api/me` |
// |--------------------------------------|----------------------|--------------------|---------------|
// | 不发（URLSession 默认）              | 200                  | 200                | 200           |
// | api 自己的源（=`BETTER_AUTH_URL`）   | 200                  | 200                | 200           |
// | 自己编的（`http://evil.example.com`）| 403 `INVALID_ORIGIN` | 200                | 200           |
//
// ✅ **iOS 该发什么：固定发 `Origin: <api base URL 的源>`**（即 `BETTER_AUTH_URL` 的
// scheme+host+port；客户端本来就知道 api 地址，`URLComponents` 取一下即可）。
// 理由：better-auth 恒把 `baseURL` 的源放进 trustedOrigins（`getTrustedOrigins`——不用配、
// 也不用往 `AUTH_TRUSTED_ORIGINS` 里加），所以这个值在"强制校验"和"不校验"两条分支下都通得
// 过；而"什么都不发"只在"不校验"那条分支下成立，将来 better-auth 把校验改成无条件就会整体
// 挂掉。两种都实测通过，但发 Origin 的那条更抗升级。
//
// ❌ 不要自己发明 origin（自定义 scheme 如 `agentcoordinator://` 也不要）：不在信任清单里
// 就是 403 `INVALID_ORIGIN`，而把一个值加进 `AUTH_TRUSTED_ORIGINS` 会同时把它加进 CORS
// 白名单，等于为了客户端放宽浏览器侧的信任边界。
//
// **5. bearer 相关的错误分支（实测）**
//
// | 场景                                                | status | body / code                              |
// |-----------------------------------------------------|--------|------------------------------------------|
// | `/api/me` token 无效/过期/伪造/格式错/裸 id         | 401    | `apiErrorSchema` `UNAUTHENTICATED`       |
// | `/api/me` 完全不带凭证                              | 401    | `apiErrorSchema` `UNAUTHENTICATED`       |
// | `sign-out` 带已失效的 token                         | 200    | 幂等成功，不下发新 token                 |
// | `sign-up`/`sign-in` 发了不可信 Origin               | 403    | `betterAuthErrorSchema` `INVALID_ORIGIN` |
//
// ⚠️ 上表第一行和第二行的响应**逐字节相同**：服务端不告诉你 token 是"签名错"还是"会话没了"
// 还是"根本没发"（`security.md`）。客户端拿到 401 的唯一正确反应是：清掉 Keychain 里的
// token、回到登录态。不要试图从响应里区分原因，也不要据此重试。
//
// 其余错误分支（密码太短、重复邮箱、限流……）与 cookie 路径完全一致，见上面那张表。
// **限流对 bearer 一视同仁**：`/api/auth/*` 由 better-auth 限（读 `X-Retry-After`），
// `/api/me` 由本服务按 IP+路径限（读 `Retry-After`），带 token 不会豁免。
//
// **6. 为什么 web 不走这条路**
//
// `set-auth-token` 也会出现在 web 的登录响应上，但它**不在** CORS 的
// `Access-Control-Expose-Headers` 里，`Authorization` 也不在 `Access-Control-Allow-Headers`
// 里——跨源的浏览器 JS 既读不到这个头、也发不出 bearer。这是刻意的：web 的会话只存在
// httpOnly cookie 里，XSS 拿不到可直接复用的 token。web 端不要改用 bearer。
export const SESSION_TOKEN_HEADER = "set-auth-token";

/** 按契约拼出 `Authorization` 头的值。token 原样带上，不做任何编码。 */
export const bearerAuthorization = (token: string): string => `Bearer ${token}`;
