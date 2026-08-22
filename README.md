# agent-coordinator

多端 agent 协调平台的 monorepo：Web 控制台（Next.js）、HTTP API（Hono，单体模块化）、队列 worker（Redis）、iOS App（SwiftUI）。目前已交付：邮箱密码认证（web 走 cookie 会话，原生客户端走 bearer token）与 Web 端终端操作台设计系统。

## 仓库布局

| 目录 | 说明 | 包名 |
|---|---|---|
| `apps/web` | Next.js 16.2 前端（Tailwind v4 + shadcn/ui） | `@agent-coordinator/web` |
| `apps/api` | HTTP API（Hono + Drizzle/PostgreSQL 17） | `@agent-coordinator/api` |
| `apps/worker` | 队列/后台任务（Redis） | `@agent-coordinator/worker` |
| `apps/ios` | SwiftUI App（xcodebuild 独立构建，不属于 pnpm workspace） | — |
| `packages/contracts` | API 契约唯一来源（zod schema + 类型） | `@agent-coordinator/contracts` |
| `packages/typescript-config` | 共享 tsconfig | `@agent-coordinator/typescript-config` |

## 环境要求

- Node.js ≥ 22.22.1，pnpm 11（仓库声明了 `packageManager`，用 `corepack enable` 即可获得正确版本）
- Docker（本地 PostgreSQL 17 + Redis 7 走 docker compose）
- iOS 开发另需 Xcode（见 `apps/ios/README.md`）

## 快速开始

```bash
pnpm install
pnpm infra:up                                # 起 postgres + redis，--wait 等健康检查就绪
cp .env.example .env                         # 按文件内说明生成 BETTER_AUTH_SECRET：
                                             #   openssl rand -hex 32（留空则 api 启动即失败）
pnpm --filter=@agent-coordinator/api db:migrate
pnpm --filter=@agent-coordinator/api dev     # api 监听 3001
pnpm --filter=@agent-coordinator/web dev     # web 监听 3000（另开终端）
```

打开 http://localhost:3000 注册账号即可走通登录/登出全流程。

## 常用命令

| 命令 | 说明 |
|---|---|
| `pnpm build` / `pnpm typecheck` / `pnpm test` | turbo 按依赖图执行并缓存；单包加 `--filter=@agent-coordinator/<name>` |
| `pnpm check` / `pnpm check:fix` | biome 格式 + lint（仓库级） |
| `pnpm infra:up` / `infra:down` / `infra:reset` | 本地基建起 / 停 / 清空重建 |
| `pnpm --filter=@agent-coordinator/api db:generate` | 改 schema 后生成 drizzle 迁移（迁移文件入库） |
| `pnpm --filter=@agent-coordinator/web test:e2e` | 真实浏览器验收认证流程（前置步骤见 `apps/web/e2e/README.md`） |

集成测试打真实数据库，跑 `pnpm test` 前先 `pnpm infra:up`。提交经 husky 钩子跑 lint-staged 与 commitlint（Conventional Commits）；main 受保护，一律走功能分支 + PR（squash 合入）。

## 文档索引

- [`CLAUDE.md`](./CLAUDE.md) — agent 工作流、配置分层与硬性规则入口（规则细则在 `.claude/rules/`，任务 SOP 在 `.claude/skills/`）
- [`apps/web/DESIGN.md`](./apps/web/DESIGN.md) — Web 端设计系统（终端操作台方向），一切 UI 工作的视觉约束来源
- [`apps/web/e2e/README.md`](./apps/web/e2e/README.md) — 认证流程真实浏览器验收：为什么存在、怎么跑、端口被占怎么办
- [`apps/ios/README.md`](./apps/ios/README.md) — iOS 工程约定与会话凭证形态（bearer token）
