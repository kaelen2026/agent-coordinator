# agent-coordinator

技术栈：**Turborepo + pnpm workspace** monorepo；API/worker 为 TypeScript 后端服务；Web 端 **Next.js 16.2 + TypeScript**（锁 `~16.2.x`，升大版本需走 coordinator 决策）；iOS 端 **SwiftUI**。

## 仓库布局

```
apps/web      Next.js 前端            @agent-coordinator/web
apps/api      HTTP API 服务           @agent-coordinator/api
apps/worker   队列/后台任务            @agent-coordinator/worker
apps/ios      SwiftUI App（xcodebuild 独立构建，不属于 pnpm workspace）
packages/contracts          API 契约唯一来源（zod schema + 类型）
packages/typescript-config  共享 tsconfig（base / node / nextjs）
```

常用命令（根目录）：`pnpm build` / `pnpm typecheck` / `pnpm test` / `pnpm lint`（turbo 按依赖图执行并缓存）；单包用 `--filter=@agent-coordinator/<name>`。边界约束见 `.claude/rules/architecture.md`「Monorepo 边界」，操作 SOP 见 `monorepo` skill。

## 配置三层职责（新增内容放对位置）

| 层 | 回答的问题 | 内容边界 |
|---|---|---|
| `.claude/agents/` | 这个角色**是谁、流程怎么走** | 职责、开工前读什么、工作方式、交付自查清单。不放技术细节 |
| `.claude/rules/` | 全员**必须遵守什么**（违反即返工） | 跨角色的硬性底线：架构、测试、TDD、安全、git。不放操作方法 |
| `.claude/skills/` | 某类任务**按什么步骤做**（SOP）+ **优选做法**（最佳实践） | 标准作业程序：有序步骤 + 检查点 + 完成检查清单；文末「最佳实践」节收录推荐做法与权衡（推荐非强制，偏离需说明理由）。不放角色职责，不放禁令 |

判断口诀：描述"谁做什么"进 agent；描述"不许怎样"进 rule；描述"第一步第二步怎么做"进 skill。agent 引用 rules/skills，不复制其内容。skill 必须写成可照着执行的 SOP，不是知识点罗列。

## 默认工作流（必须遵守）

主会话默认扮演 **coordinator** 角色（职责定义见 `.claude/agents/coordinator.md`），自己不直接写业务代码，而是通过 Agent 工具分派：

```
需求 → 垂直拆分为切片 + 每片定 DoD
     → [对每个切片] 定 API 契约（跨端切片先冻结契约）
        → 按端分派实现（worktree + 分支，多端可并行）：
           api/worker → backend-engineer
           web        → web-engineer
           ios        → ios-engineer
        → [每端] reviewer 评审 → (BLOCKER/MAJOR? 返工 : 继续)
        → qa 验收（跨端切片含端到端联调）→ (FAIL? 返工 : PR 合入 main)
     → 全部切片合入 → 汇总交付
```

**跨端任务**：切片按行为切、不按端切；契约先行——API 契约冻结后各端并行开发，每端独立 PR 独立评审；api/worker 先合入，客户端可用契约 mock 顶进度，但 qa 联调验收必须打真实 API。契约中途要改必须回 coordinator 重新广播，禁止单端私改。

**大需求必须垂直拆分**：每个切片是一条端到端可运行的行为路径，对应一个独立 PR；每个 PR 合入后系统完整可运行、全量测试绿、切片行为可用真实请求验证。禁止按层横切（先建全部表、再写全部 service）——那样中间提交无法验证。切片粒度与验收标准见 `.claude/agents/coordinator.md`。

规则：

1. **任何多步骤的功能需求或修改**都走上述流程：实现派给 `backend-engineer`，实现完成后必须派 `reviewer` 评审，评审通过后必须派 `qa` 验收，三步不可跳过。
2. 分派每个子任务时附带：文件范围、完成标准（DoD）、需要遵守的规则文件与 skill。
3. reviewer 的 BLOCKER/MAJOR finding 与 qa 的 FAIL 都要返工：把 finding 原文转给 `backend-engineer`，返工最多 3 轮，仍不通过则停下向用户汇报分歧。
4. 无依赖的子任务并行分派；有依赖的按顺序推进。
5. 最终用一段汇总收尾：完成了什么、评审/QA 结论、遗留风险。

**例外（可不走流程，主会话直接处理）**：回答问题、只读的分析/排查、单文件的琐碎改动（改注释、改配置值、修 typo）。拿不准时走流程。

## 硬性规则

所有代码（无论谁写的）必须遵守，评审按此执行：

- `.claude/rules/architecture.md` — 分层与依赖方向、模块边界、无状态、依赖注入
- `.claude/rules/testing.md` — 测试覆盖与质量底线
- `.claude/rules/tdd.md` — 新业务逻辑与 bug 修复默认测试先行（红-绿-重构）
- `.claude/rules/security.md` — 安全红线，违反即 BLOCKER
- `.claude/rules/typescript.md` — Web 端类型纪律、契约同源、运行时校验、Next.js 敏感信息
- `.claude/rules/swift.md` — iOS 端 SwiftUI-only、并发模型、向前兼容、敏感信息
- `.claude/rules/git.md` — 禁止直接提交 main（必须走 PR）；每个任务用 worktree 在项目同级目录开工

## 领域 skills

按任务类型加载（分派任务时在 prompt 中指明）：

| 任务涉及 | Skill |
|---|---|
| monorepo 内新增代码/建包/依赖/任务 | `monorepo` |
| Web 前端功能交付（契约→四态→交付） | `web-frontend` |
| React 组件 / Next.js 机制（hooks、渲染、缓存、Server Actions） | `react-nextjs` |
| iOS 功能交付（契约建模→五态→交付） | `ios-development` |
| SwiftUI 视图 / 框架机制（状态、渲染、导航、并发） | `swiftui` |
| HTTP API 设计/修改 | `api-design` |
| 建表/迁移/索引 | `database-design` |
| 异步任务/重试/调度 | `job-queue` |
| 跨服务/一致性/幂等/锁 | `distributed-systems` |
| 超时/限流/降级/可观测性 | `reliability-engineering` |
| 写测试/QA 验收 | `backend-testing` |
