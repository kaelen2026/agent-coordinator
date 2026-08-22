# iOS App（SwiftUI）

Xcode 工程放在本目录（不属于 pnpm workspace，不参与 turbo 任务图）。

- 创建工程时：项目名 `AgentCoordinator`，UI 框架 SwiftUI，硬性约束见 `.claude/rules/swift.md`。
- API 契约以 `packages/contracts` 为唯一来源；Codable 模型据此手写或生成，向前兼容要求见 `.claude/skills/ios-development/SKILL.md` 步骤 1。
- 会话凭证走 **bearer token**（api 已接 better-auth bearer plugin，web 的 cookie 路径与 iOS 无关）：登录/注册响应头下发会话 token，之后请求带 `Authorization: Bearer`。响应头名、Origin 要求与错误分支以 `packages/contracts` 里的实测契约为唯一来源；token 只能存 Keychain（`.claude/rules/swift.md` 的 BLOCKER 条款）。
- 构建与测试通过 `xcodebuild` 独立运行，QA 联调走模拟器打真实 API。
