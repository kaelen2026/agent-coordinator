import { createMiddleware } from "hono/factory";
import { AppError } from "./errors.js";

export type CsrfOptions = {
  /** 可信源清单。复用 AUTH_TRUSTED_ORIGINS（同时也是 CORS 白名单），不新增环境变量。 */
  trustedOrigins: string[];
  /**
   * 本服务自己的地址（`BETTER_AUTH_URL`）。它的源**恒可信**，与上面那份清单取并集——
   * 镜像 better-auth 的 `getTrustedOrigins`（它同样恒把 baseURL 的源并进信任清单）。
   * 单独一个参数而不是让调用方自己拼进 trustedOrigins：这条规则不能被"改配置"改掉，
   * 漏了它 iOS 的全部写操作就是 403（见下面 ⚠️）。
   */
  ownBaseUrl: string;
  /** 返回 true 的路径跳过本中间件（`/api/auth/*` 由 better-auth 自己校验）。 */
  isExempt?: (path: string) => boolean;
};

/** 只有会改变状态的方法需要防 CSRF；GET/HEAD/OPTIONS 无副作用。 */
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * 清单里填的是给人看的 URL（可能带尾斜杠、带路径），`Origin` 头是序列化后的源。
 * 比较前归一化成源，否则一个尾斜杠就能让整个 web 端 403。解析不了的条目直接丢弃——
 * env 层已经保证是 http(s) URL，这里只是不让一个坏条目变成"清单为空、全部拒绝"。
 */
const toOriginSet = (entries: string[]): Set<string> =>
  new Set(entries.flatMap((entry) => (URL.canParse(entry) ? [new URL(entry).origin] : [])));

/**
 * 自有状态改变端点的 CSRF 防线：**带 `Cookie` 头的写请求必须带可信 `Origin`**。
 *
 * 为什么按"有没有 cookie"分流（镜像 better-auth `origin-check` 的 useCookies 分支）：
 * CSRF 的前提是浏览器**自动附带**凭证，而只有 cookie 会被自动附带。bearer token 必须由
 * 客户端主动写进 `Authorization` 头，攻击者的跨站页面既读不到它、也发不出它（该头不在
 * CORS 的 Access-Control-Allow-Headers 里）——所以「bearer + 恶意 Origin」这一格拿不出
 * 任何凭证，真打进来就是 401，**跳过校验是正确的，不是放宽**。
 *
 * ⚠️ 这与 better-auth 对 `sign-in` / `sign-up` 的行为**有意不同**：它的
 * `formCsrfMiddleware` 在请求带了 Origin / `Referer` / `Sec-Fetch-*` 时会强制校验，
 * 即使一个 cookie 都没有（见 packages/contracts 第 4 节的 9 格矩阵）。我们不照搬那条更
 * 严的分支，理由是它会把「iOS 能不能调用自有写接口」绑到"URLSession 到底发了什么头"这个
 * 本仓库没有实测的推断上——客户端不可热修，赌错的代价是全量写操作 403，而换来的安全收益
 * 是零（那一格本来就没有可被冒用的凭证）。
 *
 * 缺 Origin 与 Origin 不可信合并为同一个 `INVALID_ORIGIN`：调用方能做的补救完全相同
 * （发一个可信的 Origin），分成两个 code 只是多一份要跨端维护的契约。
 *
 * ⚠️ **api 自身的源恒在可信集合里**（`ownBaseUrl`），这不是放宽：
 *   - `Origin` 由浏览器控制，跨站页面**无法**把它伪造成 api 自己的源；
 *   - 非浏览器调用方能伪造任何 Origin，但它同样可以干脆不发 cookie——CSRF 防的是"浏览器
 *     自动附带凭证"，不是"有人能构造请求"。放宽与不放宽对它没有区别。
 *   而漏掉这一条的代价是实打实的：iOS 会**同时**带 cookie 和 bearer（better-auth 的 sign-in
 *   响应也下发会话 cookie，默认 URLSession 会收进 jar），因此必然走进本校验；契约要求它固定
 *   发 `Origin: <api 自身的源>`，而那个值不在 `AUTH_TRUSTED_ORIGINS` 里（那份清单同时是 CORS
 *   白名单，为了 iOS 往里加东西等于放宽浏览器侧的信任边界）。不信任自身源 = iOS 全部写操作
 *   403，而客户端不可热修。
 */
export const csrfMiddleware = ({ trustedOrigins, ownBaseUrl, isExempt }: CsrfOptions) => {
  const allowed = toOriginSet([...trustedOrigins, ownBaseUrl]);

  return createMiddleware(async (c, next) => {
    if (!STATE_CHANGING_METHODS.has(c.req.method) || isExempt?.(c.req.path) === true) {
      await next();
      return;
    }

    // 没有 cookie 就没有"浏览器自动附带的凭证"，也就没有 CSRF 面
    if (c.req.raw.headers.get("cookie") === null) {
      await next();
      return;
    }

    // 逐字符比对序列化后的源：不做前缀/后缀匹配（`http://localhost:3000.evil.com` 必须被拒），
    // 也不解析收到的值（沙箱 iframe 发的字面量 `null` 不能被当成合法源）。
    const origin = c.req.raw.headers.get("origin");
    if (origin === null || !allowed.has(origin)) {
      // 不回显收到的 Origin：外部输入不反射进响应（security.md）
      throw new AppError(403, "INVALID_ORIGIN", "request origin is not trusted");
    }

    await next();
  });
};
