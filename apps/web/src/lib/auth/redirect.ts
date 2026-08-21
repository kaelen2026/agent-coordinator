import { z } from "zod";

/**
 * 登录跳转目标的处理。`redirectTo` 来自 URL 查询参数，是不可信的外部输入
 * （security.md「一切外部输入视为不可信」），必须在这里收敛成一个站内路径，
 * 否则登录页就成了开放重定向跳板。
 */

/** 登录/注册成功后的默认落地页。 */
export const DEFAULT_AFTER_AUTH_PATH = "/dashboard";

export const SIGN_IN_PATH = "/sign-in";
export const SIGN_UP_PATH = "/sign-up";

/** 认证页本身不能作为跳转目标，否则登录成功后原地打转。 */
const AUTH_PATHS = [SIGN_IN_PATH, SIGN_UP_PATH];

/** 浏览器解析 URL 时会忽略这些控制字符，判断归属前必须先剔除。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要清掉浏览器会忽略的控制字符
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/**
 * 只放行"单个斜杠开头的站内路径"。
 *
 * 特别拦掉 `//host` 与 `/\host`：浏览器会把它们当协议相对地址跳到站外；
 * 中间还可能夹着被浏览器忽略的控制字符（`/\t/host`），所以先剔除再判断。
 */
export const safeRedirectTarget = (raw: unknown): string => {
  // searchParams 是运行时边界数据，先过 schema 再进类型世界（typescript.md）
  const parsed = z.string().safeParse(raw);
  if (!parsed.success) return DEFAULT_AFTER_AUTH_PATH;

  const candidate = parsed.data.replace(CONTROL_CHARS, "").trim();

  if (!candidate.startsWith("/")) return DEFAULT_AFTER_AUTH_PATH;
  if (candidate.startsWith("//") || candidate.startsWith("/\\")) return DEFAULT_AFTER_AUTH_PATH;

  const pathname = candidate.split(/[?#]/)[0] ?? "";
  if (AUTH_PATHS.includes(pathname)) return DEFAULT_AFTER_AUTH_PATH;

  return candidate;
};

/**
 * 由当前路径拼出登录页地址，把来源带在 `redirectTo` 上，登录后能回到原处。
 * 来源非法（站外、伪协议、认证页自身）时先被消毒成默认落地页，再照常编码进去——
 * 始终带参数比"某些情况下省略"更容易预期。
 */
export const signInPathFor = (from: string): string =>
  `${SIGN_IN_PATH}?redirectTo=${encodeURIComponent(safeRedirectTarget(from))}`;
