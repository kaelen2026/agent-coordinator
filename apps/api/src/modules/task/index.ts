// 模块公开入口：跨模块/组装层只允许 import 这里，不深入模块内部文件。
export { createTaskRepo } from "./repo.js";
export { createTaskRoutes, type TaskRoutesDeps } from "./routes.js";
export type { TaskDeps, TaskRepo } from "./service.js";
