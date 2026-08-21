/**
 * 进程级不变量：**任何库的错误对象都不得被交给序列化器**。
 *
 * 背景（同一条红线已经以两种形态出现过）：
 *   1. better-auth 的默认 logger 把 args 原样 console 出来 —— 泄漏会话 token；
 *   2. better-call 在 router 里硬编码 `console.error("# SERVER_ERROR: ", error)`
 *      （`better-call/dist/router.mjs`），logger 配置管不到 —— 泄漏登录邮箱。
 *
 * 这类错误对象把用户数据藏在三个地方，逐个过滤是抓不干净的：
 *   - `message`（drizzle 把 `params: <值>` 拼进消息）
 *   - 自有属性（`DrizzleQueryError` 带 `query` / `params`）
 *   - `cause` 链（Node 的 console 会顺着打印）
 *
 * 所以这里不做"按已知泄漏点打补丁"，而是在**唯一的公共出口 console 上**做拦截：
 * 凡是 Error / 对象，一律收敛成「类型名 + 结构化错误码」的描述符，取值一个不留。
 *
 * **边界：字符串与基本类型原样通过**。必须如此——我们自己的日志就是拼好的 JSON 字符串，
 * 拦字符串等于把日志全废掉。这条边界的安全性靠审计保证：已逐个看过依赖里全部
 * console.* 调用点（better-auth / @better-auth/core / better-call / pg /
 * @hono/node-server / drizzle-orm / hono），拼进字符串的只有静态文案、合成的调用栈、
 * 以及 provider id / JSON key 这类非凭证标识；唯一会把查询参数拼成字符串打出来的是
 * adapter 的 debugLogs，已在 `modules/auth/auth.ts` 显式关闭。
 * 审计时还发现一件事，**启用新功能前必须复查**：`@better-auth/core` 里除了 app 配置的
 * logger，还有一个模块级单例 `const logger = createLogger()`（`dist/env/logger.mjs`），
 * core 内部广泛使用它，`betterAuth({ logger })` 管不到、也改不了它的 level。本切片够不到
 * 它上面含凭证的消息，但 `dist/oauth2/*` 与 `dist/social-providers/*` 里有一批
 * `logger.error(\`... ${e.message}\`)` 走的正是这个单例——**做社交登录 / OAuth 时会绕过
 * app 的 logger 配置**，届时要重新评估（它最终仍会落到 console，所以本模块的防护还在，
 * 但字符串形态的消息拦不住）。
 *
 * 升级这些依赖、或启用新功能时，应重跑一次该审计。
 */

const MAX_CAUSE_DEPTH = 5;
/** 错误码只接受短的标量（如 pg 的 `42P01`），超出长度的一律视为可能携带数据。 */
const MAX_CODE_LENGTH = 32;

/** 错误的可记录摘要：只有类型与错误码，不含任何取值。 */
export type ErrorDescriptor = {
  name: string;
  code?: string;
  cause?: ErrorDescriptor;
};

const readCode = (error: object): string | undefined => {
  if (!("code" in error)) {
    return undefined;
  }
  const code: unknown = error.code;
  if (typeof code === "number") {
    return String(code);
  }
  if (typeof code === "string" && code.length > 0 && code.length <= MAX_CODE_LENGTH) {
    return code;
  }
  return undefined;
};

/**
 * 把错误收敛成排障够用、又不含用户数据的描述符。
 *
 * 保留 `name` 与 `code` 是有意的：`DatabaseError code=42P01`（表不存在）和
 * `code=57014`（statement_timeout）足以区分"数据库挂了"和"代码有 bug"，
 * 而它们是 Postgres 的结构化常量，不是用户数据。
 */
export const describeError = (value: unknown, depth = 0): ErrorDescriptor => {
  if (!(value instanceof Error)) {
    return { name: typeof value === "object" && value !== null ? "object" : typeof value };
  }
  const code = readCode(value);
  const cause =
    depth < MAX_CAUSE_DEPTH && value.cause !== undefined && value.cause !== null
      ? describeError(value.cause, depth + 1)
      : undefined;

  return {
    // constructor.name 比 error.name 更贴近真实类型（pg 的 DatabaseError 把 name 设成 "error"）
    name: value.constructor?.name ?? value.name,
    ...(code === undefined ? {} : { code }),
    ...(cause === undefined ? {} : { cause }),
  };
};

/** console 单个参数的脱敏。 */
export const redactLogArg = (arg: unknown): unknown => {
  if (arg instanceof Error) {
    return describeError(arg);
  }
  if (typeof arg === "object" && arg !== null) {
    // 普通对象同样可能是库塞满数据的载体，只留类型名
    return `[${arg.constructor?.name ?? "object"}]`;
  }
  return arg;
};

type ConsoleMethod = "error" | "warn" | "log" | "info" | "debug" | "trace";

/** 只依赖用到的这几个方法，测试可以传一个假 console，不必造出整个 Console。 */
export type RedactableConsole = Pick<
  Console,
  "error" | "warn" | "log" | "info" | "debug" | "trace" | "dir"
>;

const GUARDED_METHODS: readonly ConsoleMethod[] = [
  "error",
  "warn",
  "log",
  "info",
  "debug",
  "trace",
];

/**
 * 在进程入口安装 console 防护，返回还原函数。
 *
 * 之所以只能改全局 console：better-call 那句 `console.error` 是硬编码的，
 * 除了在全局出口上拦，没有别的注入点（除非 fork 掉那个库）。
 */
export const installConsoleRedaction = (target: RedactableConsole = console): (() => void) => {
  const restores: (() => void)[] = [];

  for (const method of GUARDED_METHODS) {
    // 存原始引用用于还原（还原成 bind 出来的副本会导致重复安装时越包越深），
    // 另存一份绑定版用于调用
    const original = target[method];
    const call = original.bind(target);
    restores.push(() => {
      target[method] = original;
    });
    target[method] = (...args: unknown[]): void => {
      call(...args.map(redactLogArg));
    };
  }

  // console.dir 的签名与上面几个不同（第二个参数是 InspectOptions），单独包一层——
  // 漏掉它就等于留了个能把整个错误对象 dump 出来的口子
  const originalDir = target.dir;
  const callDir = originalDir.bind(target);
  restores.push(() => {
    target.dir = originalDir;
  });
  target.dir = (item: unknown, options?: Parameters<Console["dir"]>[1]): void => {
    callDir(redactLogArg(item), options);
  };

  return () => {
    for (const restore of restores) {
      restore();
    }
  };
};
