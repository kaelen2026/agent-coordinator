import { z } from "zod";
import { AppError } from "../../shared/errors.js";

/**
 * 游标分页的键。排序键是 `(createdAt, id)`——同一时间戳并列时由 id 决胜，
 * 所以游标必须同时带上两者，否则并列行会在翻页时重复或漏掉。
 */
export type TaskCursor = { createdAt: Date; id: string };

/**
 * 对外不透明的编码：`base64url(<ISO 时间戳>|<id>)`。
 *
 * 不透明是**契约层面的承诺**（客户端只能原样回传），不是安全边界——它没有签名，
 * 客户端完全可以自己造一个。这没有风险：归属过滤在 service 层按当前会话的 userId 做，
 * 伪造游标最多只能换一个自己数据的起点，翻不到别人的行。所以不引入 HMAC（多一个密钥、
 * 多一次轮转，换不到任何实际保障）。
 *
 * base64url 而不是标准 base64：游标要原样出现在查询串里，`+` `/` `=` 都得再编码一次，
 * 客户端一旦漏了就是 400。
 */
const SEPARATOR = "|";

/**
 * 解码前的长度上限。查询串**不受 `bodyLimit` 保护**，不设上限等于允许调用方用一个
 * 超长游标白拿一次 base64 解码 + 校验的 CPU。真实游标是 ~50 字节，256 是宽松余量。
 */
const MAX_ENCODED_LENGTH = 256;

const payloadSchema = z.object({
  createdAt: z.string().datetime(),
  id: z.string().min(1),
});

const invalid = (): AppError =>
  // 不回显收到的游标值：外部输入不反射进响应（security.md）。
  new AppError(400, "VALIDATION_ERROR", "cursor is not a value this endpoint issued", [
    { field: "cursor", message: "must be a nextCursor returned by this endpoint" },
  ]);

export const encodeTaskCursor = ({ createdAt, id }: TaskCursor): string =>
  Buffer.from(`${createdAt.toISOString()}${SEPARATOR}${id}`, "utf8").toString("base64url");

/** 解不开的游标是不可重试的调用方错误：抛 400，绝不静默退回第一页。 */
export const decodeTaskCursor = (raw: string): TaskCursor => {
  if (raw.length === 0 || raw.length > MAX_ENCODED_LENGTH) {
    throw invalid();
  }

  // Buffer 的 base64url 解码对非法字符是宽容的（直接跳过），所以不能靠它报错——
  // 得靠下面对解出来的内容做严格校验。
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const separatorAt = decoded.indexOf(SEPARATOR);
  if (separatorAt < 0) {
    throw invalid();
  }

  // id 本身可能含分隔符，所以只按**第一个**分隔符切开：时间戳里不会有它。
  const parsed = payloadSchema.safeParse({
    createdAt: decoded.slice(0, separatorAt),
    id: decoded.slice(separatorAt + SEPARATOR.length),
  });
  if (!parsed.success) {
    throw invalid();
  }

  // 只接受**我们自己发出去过的那种写法**：`Date.toISOString()` 的产物（`Z` 结尾、恒三位小数）。
  // 这一步兜的是"合法 ISO 8601、但我们从不生成"的拼法——秒级精度（`…10:00:00Z`）、被截短的
  // 小数位（`…00.0Z`）之类。它们能通过上面的 schema，`new Date()` 也认，但出现就说明这个游标
  // 是客户端自己拼的，而拼游标是契约明令禁止的（格式不透明、服务端可随时换实现）。
  //
  // 顺带说明它**不**负责什么：日历上不存在的日期（`2026-02-31`）在当前依赖版本（zod 3.25.76）
  // 下已经被上面 `.datetime()` 挡掉了，不是靠这一步——别读成"往返检查是为了兜住日历非法值"。
  // `Number.isNaN` 那半同理，是纯防御。
  const createdAt = new Date(parsed.data.createdAt);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== parsed.data.createdAt) {
    throw invalid();
  }

  return { createdAt, id: parsed.data.id };
};
