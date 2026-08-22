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
// 反过来，表里「缺失 Origin 头」那一行**不是无条件的 403**：既不带 cookie、也不带
// `Referer` / `Sec-Fetch-*` 的裸请求（iOS `URLSession` 的默认形态）反而是 200。
// 完整触发条件见下面 bearer 章节第 4 节。
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
// ⚠️ 「不要 URL 编解码」这条读起来像"编码了就会失败"，实际不是：**服务端当前会容忍百分号编码**
// （bearer 被翻译成会话 cookie 后走 cookie 解析，顺手解掉一层），`encodeURIComponent(token)`
// 发过去照样 200。但这是**当前观测到的宽容度，不是契约承诺**——客户端不要依赖它，必须原样透传。
// 依赖它的代价：客户端不可热修，而这是个"错了也不报错"的坑（开发期一切正常），
// better-auth 哪天不再解码就是全量登出。宽容度本身由
// `currently_tolerates_a_percent_encoded_token_but_the_contract_still_says_pass_it_through`
// 钉住当前行为，它变了 CI 会先红——那条测试记录的是"今天的观测"，不是我们对客户端的承诺。
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
// ⚠️ 第一行（"不发 Origin"）成立的前提是**一个 `Sec-Fetch-*` 都不发**——这正是上面 b 分支的
// 触发条件之一。只发 `Sec-Fetch-*` 不发 `Origin` 会吃 403 `MISSING_OR_NULL_ORIGIN`。
// 第二行（"发 api 自己的源"）也有前提：不能是 `Sec-Fetch-Site: cross-site` 配
// `Sec-Fetch-Mode: navigate` 的跨站导航形态——那种请求在校验 Origin **之前**就被拦掉，
// Origin 再可信也是 403。两条前提对 `URLSession` 都自动满足（它一个 `Sec-Fetch-*` 都不发）。
// 两格都详见第 5 节错误分支表。
//
// 9 格逐格由 `auth.integration.test.ts` 断言钉住（"不发"与"不可信"两行在
// `origin requirements for native clients` 里，"api 自己的源"那一行由 bearer 各测试用 `NATIVE`
// 覆盖）：better-auth 把 origin 校验改成无条件时，CI 会先红，而不是 CI 全绿、契约变成错的。
//
// ✅ **iOS 该发什么：固定发 `Origin: <api base URL 的源>`**（即 `BETTER_AUTH_URL` 的
// scheme+host+port；客户端本来就知道 api 地址，`URLComponents` 取一下即可）。
// 理由：better-auth 恒把 `baseURL` 的源放进 trustedOrigins（`getTrustedOrigins`——不用配、
// 也不用往 `AUTH_TRUSTED_ORIGINS` 里加），所以这个值在"强制校验"和"不校验"两条分支下都通得
// 过；而"什么都不发"只在"不校验"那条分支下成立，将来 better-auth 把校验改成无条件就会整体
// 挂掉。两种都实测通过，但发 Origin 的那条更抗升级。
//
// ⚠️ **这条建议带一个部署耦合，必须显式满足**：矩阵第二行成立的前提是"客户端配的 api 基址的源"
// 与"服务端 `BETTER_AUTH_URL` 的源"**逐字相同**（scheme、host、端口，别名/CDN 域名都算不同）。
// 两者不同源的部署很常见（iOS 走 `https://api-mobile.example.com`，而 `BETTER_AUTH_URL` 是
// `https://api.example.com`）：这时 iOS 发出的 Origin 会走 `formCsrfMiddleware` 的强制分支、
// 又不在信任清单里 → 该环境下 `sign-up` / `sign-in` 直接 403。客户端不可热修，只能靠服务端救。
// 所以约束是：**iOS 发的 Origin 必须与服务端 `BETTER_AUTH_URL` 的源逐字相同；做不到就必须把
// iOS 实际发出的那个源加进 `AUTH_TRUSTED_ORIGINS`**（注意那个清单同时是 CORS 白名单，加进去
// 等于浏览器侧多一个可信源，要在评审里权衡）。任何新环境上线前，用类生产配置实测一次
// `sign-in` 不是 403。
//
// ❌ 不要自己发明 origin（自定义 scheme 如 `agentcoordinator://` 也不要）：不在信任清单里
// 就是 403 `INVALID_ORIGIN`，而把一个值加进 `AUTH_TRUSTED_ORIGINS` 会同时把它加进 CORS
// 白名单，等于为了客户端放宽浏览器侧的信任边界。
//
// **5. bearer 相关的错误分支（实测）**
//
// | 场景                                                 | status | body / code                                                   |
// |------------------------------------------------------|--------|---------------------------------------------------------------|
// | `/api/me` token 无效/过期/伪造/格式错/裸 id          | 401    | `apiErrorSchema` `UNAUTHENTICATED`                            |
// | `/api/me` 完全不带凭证                               | 401    | `apiErrorSchema` `UNAUTHENTICATED`                            |
// | `sign-out` 带已失效的 token                          | 200    | 幂等成功，不下发新 token                                      |
// | `sign-up`/`sign-in` 发了不可信 Origin                | 403    | `betterAuthErrorSchema` `INVALID_ORIGIN`                      |
// | `sign-up`/`sign-in` 发了 `Sec-Fetch-*` 但没发 Origin | 403    | `betterAuthErrorSchema` `MISSING_OR_NULL_ORIGIN`              |
// | `sign-up`/`sign-in` 跨站导航登录（见下）             | 403    | `betterAuthErrorSchema` `CROSS_SITE_NAVIGATION_LOGIN_BLOCKED` |
//
// ⚠️ 表里**「发了 `Sec-Fetch-*` 但没发 Origin」那一行最容易被自己的 HTTP 层坑到**：
// `Sec-Fetch-*` 也算"这是浏览器发的"信号（见第 4 节的 b 分支），一旦带上它，Origin 就从
// "可以不发"变成"必须发且必须可信"。
// **任何会自动补 `Sec-Fetch-*` 的 HTTP 层都必须同时发 `Origin`**：Node/undici 的内置 `fetch`
// 默认就补 `sec-fetch-mode: cors`（实测；用它写的集成脚本什么都没做也会全量 403）。
// WKWebView 走浏览器栈、按 Fetch 规范同样会补——但**这条本仓库没实测**，真要用之前自己验一次。
// `URLSession` 不发 `Sec-Fetch-*`，所以第 4 节矩阵第一行对 iOS 仍然成立；而按第 4 节 ✅ 那条建议
// 固定发 `Origin: <BETTER_AUTH_URL 的源>`，本来就顺带把这一格规避掉了。
// 由 `origin requirements for native clients` 的两条测试钉住：
// `rejects_sign_in_that_sends_sec_fetch_headers_but_no_origin`（服务端这一侧的判定）与
// `node_fetch_without_an_origin_is_rejected_because_its_own_stack_adds_sec_fetch_mode`
// （调用方的 HTTP 栈会自己把这个头补上，不需要谁手写）。
//
// ⚠️ 但**"发了 Origin"不是万能解**——这就是上表最后一行：同一个 `formCsrfMiddleware` 里还有更严
// 的一条分支，`Sec-Fetch-Site: cross-site` 配 `Sec-Fetch-Mode: navigate`（跨站导航/表单登录的
// 形态）在校验 Origin **之前**就被拦掉，**Origin 可信也照样 403**（实测）。`URLSession` 与
// Node/undici 都构造不出这个组合（undici 恒发 `sec-fetch-mode: cors`），所以 iOS 与集成脚本都
// 不沾；WKWebView 里的跨站表单提交会。由
// `blocks_cross_site_navigation_sign_in_even_when_the_origin_is_trusted` 钉住。
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
// `set-auth-token` 会出现在**每个**建立会话的响应上，web 的登录响应也有（bearer plugin 的
// after hook 无条件执行）。但它**不在** CORS 的 `Access-Control-Expose-Headers` 里，
// `Authorization` 也不在 `Access-Control-Allow-Headers` 里——跨源的浏览器 JS 既读不到这个头、
// 也发不出 bearer。这是刻意的：web 的会话只存在 httpOnly cookie 里，XSS 拿不到可直接复用的
// token。web 端不要改用 bearer。
//
// ⚠️ 这个结论有两个前提，别当成无条件成立：
//   a. **web 与 api 跨源**（当前部署如此：web 在 `:3000`，api 在 `:3001`）。若把 api 反代到与
//      web 同一个源（同域同端口），CORS 整体不生效，同源的浏览器 JS 可以直接读
//      `set-auth-token`——那种部署下"XSS 拿不到可复用 token"这条保障就没了，需要另做加固
//      （例如在没有 `Authorization` 请求头的响应上剥掉该头）。
//   b. api 的 CORS `exposeHeaders` 清单**保持非空**：插件自己会把 `set-auth-token` 写进
//      `Access-Control-Expose-Headers`，压住它靠的是 hono cors 用非空清单覆盖该头
//      （见 `apps/api/src/app.ts` 的注释）。清单变空，插件的值就透出去了。
export const SESSION_TOKEN_HEADER = "set-auth-token";

/** 按契约拼出 `Authorization` 头的值。token 原样带上，不做任何编码。 */
export const bearerAuthorization = (token: string): string => `Bearer ${token}`;
