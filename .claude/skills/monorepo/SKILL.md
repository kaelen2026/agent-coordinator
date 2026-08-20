---
name: monorepo
description: 在本 Turborepo monorepo 中新增代码、新建包、组织依赖、运行任务时使用：代码放哪、包怎么建、依赖方向、turbo 任务与缓存的 SOP。触发词：monorepo、turborepo、workspace、包、apps、packages、依赖图。
---

# Monorepo SOP（Turborepo + pnpm workspace）

**布局**：`apps/*` 是可部署单元（web、api、worker、ios），`packages/*` 是共享库（contracts、typescript-config…）。iOS 在 `apps/ios` 但不属于 pnpm workspace，用 xcodebuild 独立构建。

## 步骤 1：决定代码放哪

1. 只有一个 app 用 → 放该 app 内部，不建包；
2. 两个以上 app 用、或属于契约 → 放 `packages/*`；
3. 契约（API schema、共享类型）只有一个家：`packages/contracts`——web/api/worker 直接 import，iOS 据此手写/生成 Codable 模型。

- ✅ 检查点：不存在 app 之间互相 import（app 只能依赖 packages）；packages 不依赖 apps。

## 步骤 2：新建包

1. 目录 `packages/<name>`，包名 `@agent-coordinator/<name>`，`"private": true`；
2. `tsconfig.json` extends `@agent-coordinator/typescript-config/node.json`（Next.js app 用 `nextjs.json`）；
3. 内部依赖一律 `"workspace:*"`；
4. `scripts` 提供与 turbo 任务同名的命令（`build`/`typecheck`/`lint`/`test`），没有的任务可不写，turbo 自动跳过；
5. 有构建产物的包在 `turbo.json` 的 outputs 覆盖范围内（`dist/**`）。

## 步骤 3：运行任务

- 全仓库：根目录 `pnpm build` / `pnpm typecheck` / `pnpm test`（turbo 按依赖图排序并缓存）。
- 只跑受影响范围：`pnpm turbo run test --filter=...[origin/main]`（PR 验证用）；单个包：`--filter=@agent-coordinator/api`。
- 新增任务类型时先在 `turbo.json` 声明（含 `dependsOn` 与 `outputs`），再到各包加同名 script。

## 步骤 4：依赖管理

- 装依赖装到用它的那个包：`pnpm --filter @agent-coordinator/web add <dep>`；根目录只放仓库级工具（turbo）。
- 多包共用的第三方依赖版本保持一致（pnpm catalog 或人工对齐），出现两个版本视为待修债务。

## 步骤 5：跨包改动的切片与 PR

- 垂直切片天然跨包（contracts + api + web 同改）：**一个切片一个 PR 可以横跨多个包**，仍要求合入后全仓库 `build/typecheck/test` 绿。
- 改 `packages/contracts` 即改契约：走 coordinator 的契约冻结/广播流程，PR 里必须包含消费方的适配。
- worktree 流程不变（见 `.claude/rules/git.md`）；注意每个 worktree 要单独 `pnpm install`。

## 完成检查

- [ ] 代码位置经过步骤 1 判定；无 app 间 import
- [ ] 新包结构符合步骤 2（命名、tsconfig、workspace 依赖、任务脚本）
- [ ] 根目录 `pnpm build && pnpm typecheck && pnpm test` 全绿
- [ ] 契约变更含消费方适配

## 最佳实践（推荐，非强制；偏离时说明理由）

- 共享包保持小而单一职责：`contracts` 只放 schema 与类型，不放请求实现——否则 iOS（无法 import TS）与后端的依赖会纠缠。
- 包的对外 API 通过 `exports` 显式声明入口，不让消费方 deep import 内部路径。
- CI 用 `--filter=...[base]` 只构建受影响的包 + turbo 远程缓存，保持 monorepo 变大后 CI 仍然快。
- 先从少量粗粒度包开始（contracts、config），按真实复用需求再拆——包数量本身是维护成本。
- `packages/typescript-config` 模式可推广：eslint 配置、测试预设同样收敛为共享包，避免每个 app 一套漂移。
