import { type AuthUser, authUserSchema } from "@agent-coordinator/contracts";
import { AppError } from "../../shared/errors.js";

// better-auth 会话里我们真正依赖的字段。声明为独立类型而不是 import better-auth 的
// 推导类型：service 因此可以在没有数据库的情况下单测，也不会随库的内部类型漂移。
export type SessionUser = {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  image?: string | null;
  createdAt: Date | string;
};

/** 读取当前请求的会话。生产实现由 better-auth 提供，测试可注入假实现。 */
export type ReadSession = (headers: Headers) => Promise<{ user: SessionUser } | null>;

const imageSchema = authUserSchema.shape.image;

// 契约要求 image 是合法 URL 或 null。数据库里存的是外部来源的字符串，
// 拿不准就降级为 null——不能让一条脏数据把 /api/me 变成 500。
const toImage = (image: string | null | undefined): string | null => {
  const parsed = imageSchema.safeParse(image ?? null);
  return parsed.success ? parsed.data : null;
};

// 会话可能来自 cookie cache（JSON 序列化过，createdAt 是字符串）而不是数据库行，
// 两种都要接住。解析不出来的值不能降级——时间戳没有安全的兜底值，
// 编一个反而更难排查，所以带上下文快速失败，由 onError 统一转成 500。
const toIsoString = (field: string, value: Date | string): string => {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`session user has an unparsable ${field}`);
  }
  return parsed.toISOString();
};

/**
 * 把会话用户映射为对外契约的白名单字段。
 * 逐字段显式构造，禁止展开整行——数据库模型带 password hash 等字段。
 */
const toAuthUser = (user: SessionUser): AuthUser => ({
  id: user.id,
  email: user.email,
  name: user.name,
  emailVerified: user.emailVerified,
  image: toImage(user.image),
  createdAt: toIsoString("createdAt", user.createdAt),
});

/** 取当前登录用户；无有效会话是不可重试的业务失败，抛稳定 code 由 onError 映射。 */
export const getCurrentUser = async (
  readSession: ReadSession,
  headers: Headers,
): Promise<AuthUser> => {
  const session = await readSession(headers);
  if (session === null) {
    throw new AppError(401, "UNAUTHENTICATED", "authentication required");
  }
  return toAuthUser(session.user);
};
