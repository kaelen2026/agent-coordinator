# Git 使用规则

以下为硬性约束，所有 agent（包括主会话）改代码前必须遵守。

## 分支保护：main 只进不改

- **禁止直接在 main 上 commit 或 push**。任何改动——包括一行的小修——都必须走：功能分支 → PR → 合入 main。
- 开工前检查当前分支：`git branch --show-current` 若是 `main`，先建分支再动手。
- 分支命名：`feat/<简述>`、`fix/<简述>`、`chore/<简述>`，用英文短横线连接，如 `feat/task-retry`。

## Worktree：每个任务独立目录

- 新任务一律用 `git worktree` 开工，**worktree 目录建在项目目录的同级**（即 `../`），命名为 `<项目名>-<分支简述>`：

```bash
# 在 /Users/kaelen/workspace/github/kaelen2026/agent-coordinator 下执行
git worktree add ../agent-coordinator-task-retry -b feat/task-retry
# 得到同级目录 /Users/kaelen/workspace/github/kaelen2026/agent-coordinator-task-retry
```

- 禁止把 worktree 建在项目目录内部（会污染仓库、被工具误扫）。
- 所有实现、测试、提交都在该 worktree 目录中进行；主项目目录保持在 main，不携带未提交改动。
- 并行的多个子任务各开各的 worktree，互不干扰。

## PR 流程

1. worktree 内完成实现，测试全绿后提交；commit message 说清"为什么"，不只是"改了什么"。
2. `git push -u origin <branch>` 后用 `gh pr create` 建 PR，PR 描述包含：改动概述、DoD 完成情况、测试证据。
3. PR 必须经过 reviewer 评审通过（无 BLOCKER/MAJOR）+ qa 验收 PASS 才能合入。
4. 合并方式统一 squash merge，保持 main 历史一条直线。

## 收尾清理

合入后及时清理，不留僵尸 worktree：

```bash
git worktree remove ../agent-coordinator-task-retry
git branch -d feat/task-retry
git worktree prune
```

## 其他约束

- 一个 PR 对应一个垂直切片（一条端到端可验证的行为路径），不把多个切片或无关改动塞进同一个 PR——顺手重构、格式化未改动的文件都算无关改动；每个 PR 合入后 main 必须完整可运行、全量测试绿。
- 禁止 force push 到 main；自己的功能分支上 force push 需先确认没有他人基于它工作。
- 提交前 `git status` 检查，不把临时文件、密钥、构建产物提交进仓库。
