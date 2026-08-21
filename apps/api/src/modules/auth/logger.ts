/** better-auth 交给日志回调的级别（它的 "success" 会被归一成 "info"）。 */
export type AuthLogLevel = "debug" | "info" | "warn" | "error";

export type AuthLogSink = (line: string) => void;

/** 库自己写的 message 之外，一律不落任何携带值的内容——见下方说明。 */
const describeArg = (arg: unknown): string => {
  if (arg instanceof Error) {
    return arg.name;
  }
  if (arg === null) {
    return "null";
  }
  if (typeof arg === "object") {
    return arg.constructor?.name ?? "object";
  }
  return typeof arg;
};

/**
 * better-auth 的日志出口。
 *
 * 为什么不用它的默认 logger：默认实现会把收到的 args 原样 `console.error(msg, ...args)`。
 * 而 drizzle 的查询错误把**绑定参数拼进了 error.message**——`/api/me` 查会话走的是
 * `where "token" = $1`，于是数据库一抖动，会话 token 就成批进日志。
 * `security.md`「日志中禁止输出完整 token」这条红线没有第三方库豁免。
 *
 * 设计原则是「库的错误详情默认不外泄」，不是针对 token 做特判——drizzle 的 params
 * 里将来可能是邮箱、也可能是别的字段。所以这里：
 *   - 放行 better-auth 自己写的静态 message（它是库里的字面量，不是从数据拼出来的）；
 *   - 每个 arg 只留**类型名**（`DrizzleQueryError`），不留 message / stack / 任何值。
 *
 * 代价是丢掉了失败的 SQL 文本。可接受：定位靠 `shared/errors.ts` 的 onError（它输出的是
 * 我们自己的 AppError/APIError 语义）+ 时间戳 + 这里的错误类型名；真要看 SQL 应当在
 * 数据库侧开慢查询/错误日志，而不是把库的原始错误往应用日志里灌。
 */
export const createAuthLogger = (sink: AuthLogSink = console.error) => ({
  disabled: false,
  // better-auth 默认只发 warn 以上；显式写出来，免得升级时默认值变了
  level: "warn" as const,
  log: (level: AuthLogLevel, message: string, ...args: unknown[]): void => {
    sink(
      JSON.stringify({
        msg: "better-auth",
        level,
        detail: message,
        ...(args.length === 0 ? {} : { causes: args.map(describeArg) }),
      }),
    );
  },
});
