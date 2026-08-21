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
 * 校验并规范化 api 基址。缺失或非法时立刻抛错（Fail fast，architecture.md）：
 * 让配置错误在启动/构建时暴露，而不是等到用户点了登录才变成一堆看不懂的网络错误。
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

// 必须原样写 `process.env.NEXT_PUBLIC_API_BASE_URL`：Next 是按字面量做构建期替换的，
// 动态取（process.env[name]）不会被内联，浏览器里就拿不到值。
export const API_BASE_URL = resolveApiBaseUrl(process.env.NEXT_PUBLIC_API_BASE_URL);
