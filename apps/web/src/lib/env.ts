import { z } from "zod";

/**
 * 浏览器侧可见的运行时配置。
 *
 * `NEXT_PUBLIC_` 前缀的值会被打进客户端 bundle，所以这里只允许放**公开信息**：
 * api 的对外地址本来就会出现在浏览器的网络面板里，不属于敏感信息（typescript.md）。
 * 任何 secret 都不得进入本文件。
 */

const nonEmptyUrlSchema = z.string().trim().min(1).url();

/** zod 的 `.url()` 会放行 `javascript:` 这类 URL，协议白名单得自己把。 */
const hasAllowedProtocol = (value: string): boolean => {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

/**
 * 校验并规范化 api 基址。缺失或非法一律抛错（Fail fast，architecture.md）：
 * 让配置错误立刻暴露，而不是等到用户点了登录才变成一堆看不懂的网络错误。
 */
export const resolveApiBaseUrl = (raw: string | undefined): string => {
  const parsed = nonEmptyUrlSchema.safeParse(raw ?? "");
  if (!parsed.success || !hasAllowedProtocol(parsed.data)) {
    throw new Error(
      "NEXT_PUBLIC_API_BASE_URL 缺失或不是合法的 http(s) 地址；请在仓库根 .env 中配置（见 .env.example）。",
    );
  }
  // 去掉末尾斜杠，拼路径时不会出现 //api/me
  return parsed.data.replace(/\/+$/, "");
};

/**
 * 构建期的占位地址。`.invalid` 是 RFC 2606 保留的顶级域，**保证永远解析不到任何主机**——
 * 万一它意外被拿去发请求，结果是 DNS 立刻失败，而不是静悄悄打到某个真实服务上。
 */
const BUILD_TIME_PLACEHOLDER = "http://api-base-url-not-configured.invalid";

/**
 * 取 api 基址。**构建期宽松、运行期严格**，这两者的边界就是"有没有浏览器"。
 *
 * 为什么要分开：`next build` 会在服务端预渲染每个页面，页面里的客户端组件模块因此
 * 也会被求值一次。如果这时就因为缺变量抛错，构建直接失败——CI 上没有仓库根 `.env`，
 * 于是 `pnpm build` 永远红（这个坑真踩过）。而预渲染阶段本来就**不会**发出任何认证
 * 请求：所有 api 调用都在客户端组件的 effect / 事件处理器里，只在浏览器里跑。
 * 所以服务端给一个必定解析失败的占位值是安全的。
 *
 * 浏览器里则**不给任何兜底**：缺了或写错就抛，让漏配立刻可见。
 * 注意占位值只存在于服务端求值时；浏览器 bundle 里被内联的是 `undefined`，
 * 走的是严格分支，占位地址不可能被发到线上去。
 *
 * 必须原样写 `process.env.NEXT_PUBLIC_API_BASE_URL`：Next 是按字面量做构建期替换的，
 * 动态取（`process.env[name]`）不会被内联，浏览器里就拿不到值。
 */
export const getApiBaseUrl = (): string => {
  const raw = process.env.NEXT_PUBLIC_API_BASE_URL;

  // 运行期（浏览器）：严格
  if (typeof window !== "undefined") return resolveApiBaseUrl(raw);

  // 构建/SSR：没配就用占位值放行；配了但写错仍然要抛，好让 typo 在构建期就被发现
  if (raw === undefined || raw.trim() === "") return BUILD_TIME_PLACEHOLDER;
  return resolveApiBaseUrl(raw);
};
