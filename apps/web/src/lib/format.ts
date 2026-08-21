/**
 * 契约里的时间戳是 ISO 字符串（`authUserSchema.createdAt`），直接渲染给用户太生硬。
 * 时区可注入，便于测试固定预期；生产走浏览器本地时区。
 */
export const formatDateTime = (iso: string, timeZone?: string): string => {
  const date = new Date(iso);
  // 服务端数据不可信：解析不出来就原样回显，绝不显示 "Invalid Date"
  if (Number.isNaN(date.getTime())) return iso;

  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const at = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${at("year")}-${at("month")}-${at("day")} ${at("hour")}:${at("minute")}`;
};
