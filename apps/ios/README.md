# iOS App（SwiftUI）

Xcode 工程放在本目录（不属于 pnpm workspace，不参与 turbo 任务图）。

- 创建工程时：项目名 `AgentCoordinator`，UI 框架 SwiftUI，硬性约束见 `.claude/rules/swift.md`。
- API 契约以 `packages/contracts` 为唯一来源；Codable 模型据此手写或生成，向前兼容要求见 `.claude/skills/ios-development/SKILL.md` 步骤 1。
- 构建与测试通过 `xcodebuild` 独立运行，QA 联调走模拟器打真实 API。
