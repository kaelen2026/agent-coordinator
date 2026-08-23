// 模块公开入口：跨模块/组装层只允许 import 这里，不深入模块内部文件。
export {
  AUTH_BASE_PATH,
  type AuthConfig,
  type AuthGateway,
  createAuth,
  readSessionFrom,
} from "./auth.js";
export { type AuthEnv, requireAuth } from "./middleware.js";
export { createAuthRoutes } from "./routes.js";
// 其它模块的表要声明"归属于某个用户"的外键时 import 这个（drizzle 的 references() 需要拿到
// 目标表对象，只给列名做不到）。**仅限声明外键**：查用户数据必须走本模块的公开 service，
// 别的模块直接 select 这张表就是越过了模块边界（architecture.md）。
export { user as userTable } from "./schema.js";
export type { ReadSession } from "./service.js";
