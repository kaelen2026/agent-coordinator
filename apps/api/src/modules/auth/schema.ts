import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// better-auth 的核心表（email+password 场景）。列名与形状对齐
// `npx @better-auth/cli generate` 的产物——库按这些字段名读写，不可自行改名。
//
// 查询路径 → 索引（database-design 步骤 1/3）：
//   注册/登录按 email 查 user            → user.email UNIQUE
//   每个请求按 token 查 session          → session.token UNIQUE
//   登出/失效按 userId 批量删 session    → session_userId_idx
//   登录时按 userId 取 credential 账号   → account_userId_idx
//   同一 issuer 下按 accountId 去重      → account_issuer_accountId_uidx
//   按 identifier 查 verification        → verification_identifier_idx
//   限流按 key 读改写                    → rateLimit.key UNIQUE

const createdAt = timestamp("createdAt", { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow();

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull().default(false),
  image: text("image"),
  createdAt,
  updatedAt,
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt,
    updatedAt,
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    issuer: text("issuer").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: timestamp("accessTokenExpiresAt", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt", { withTimezone: true }),
    scope: text("scope"),
    // 邮箱密码方式下这里存 better-auth 的 scrypt 哈希，绝不能出现在任何响应或日志里
    password: text("password"),
    createdAt,
    updatedAt,
  },
  (table) => [
    index("account_userId_idx").on(table.userId),
    uniqueIndex("account_issuer_accountId_uidx").on(table.issuer, table.accountId),
  ],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

// 限流计数落库而不是进程内存：服务无状态才能水平扩展（architecture.md）
export const rateLimit = pgTable("rateLimit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("lastRequest", { mode: "number" }).notNull(),
});
