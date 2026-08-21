// 模块公开入口：跨模块/组装层只允许 import 这里，不深入模块内部文件。
export { type AuthConfig, type AuthGateway, createAuth } from "./auth.js";
export { createAuthRoutes } from "./routes.js";
