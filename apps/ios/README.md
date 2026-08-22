# iOS App（SwiftUI）

`apps/ios` 不属于 pnpm workspace、不参与 turbo 任务图，用 `xcodebuild` 独立构建，QA 联调走
模拟器打真实 api。工程名 `AgentCoordinator`，UI 一律 SwiftUI，硬性约束见
`.claude/rules/swift.md`。API 契约以 `packages/contracts` 为唯一来源，`Contracts/` 下的
Codable 模型据此手写，向前兼容要求见 `.claude/skills/ios-development/SKILL.md` 步骤 1。

## 命令（干净 checkout 上按顺序跑）

```bash
cd apps/ios

# 1. 生成 Xcode 工程（.xcodeproj 不入库，由 project.yml 生成）
xcodegen generate

# 2. 编译
xcodebuild build \
  -project AgentCoordinator.xcodeproj \
  -scheme AgentCoordinator \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro'

# 3. 单元测试（不依赖任何外部进程）
xcodebuild test \
  -project AgentCoordinator.xcodeproj \
  -scheme AgentCoordinator \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```

格式与静态检查（配置在 `.swiftformat` / `.swiftlint.yml`）：

```bash
swiftformat --lint .   # CI 用 --lint；本地直接 `swiftformat .` 就地修
swiftlint lint --quiet # 期望 0 warning
```

### 打真实 api 的联调测试

`LiveApiIntegrationTests` 默认被 `.enabled(if:)` 跳过，只有 `AgentCoordinatorIntegration`
这个 scheme 会注入开关。它要求本机起着 api：

```bash
# 仓库根目录
pnpm infra:up
pnpm --filter=@agent-coordinator/api db:migrate
pnpm --filter=@agent-coordinator/api dev      # 另一个终端

# apps/ios
xcodebuild test \
  -project AgentCoordinator.xcodeproj \
  -scheme AgentCoordinatorIntegration \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```

开关只能由 scheme 的 test action 注入：宿主跑在 App 里的 test bundle 拿不到 `xcodebuild`
命令行上的环境变量，`TEST_RUNNER_` 前缀对它也不生效（两种都实测过）。默认 scheme 因此
天然是自足的，符合 `.claude/rules/testing.md` 的"测试必须可重复"。

联调套件会自己按服务端的限流节奏 sleep（sign-in / sign-up 每 `IP|/path` 桶每 10 秒 3 次），
所以它比单元测试慢十几秒；不要为了快去掉那些 sleep，否则测到的是 429 而不是业务。

> 模拟器里残留着上一次的未签名安装包时，`xcodebuild test` 可能报
> `Application failed preflight checks`。`xcrun simctl uninstall booted dev.agentcoordinator.ios`
> 之后重跑即可。

## 关键选择

**最低 iOS 版本：17.0。** `@Observable`（Observation 框架）是 iOS 17 起才有的，而 SwiftUI
的状态归属 SOP（`.claude/skills/swiftui`）整套建立在它之上；用 `ObservableObject` 退回
iOS 16 会让每次状态变更刷新整棵子树。iOS 17 同时提供 `ContentUnavailableView`，五态里的
空/错误/离线三态直接用系统组件，不用自己拼。再往上抬（18/26）这个切片一点收益都没有，
只会白掉设备覆盖。

**配置注入：xcconfig → Info.plist → `AppConfiguration`。** api 地址写在
`Configuration/Debug.xcconfig` / `Release.xcconfig` 的 `API_BASE_URL`，经 Info.plist 的
`APIBaseURL` 键进程序，业务代码只从 `AppConfiguration` 读。换环境只改 xcconfig，代码里
没有任何硬编码地址。读不到就 `fail fast` 停在说明页，不兜底到某个猜测的地址。

`Release.xcconfig` 的 `API_BASE_URL` **刻意留空**，发版环境必须显式传值（CI 覆盖 /
私有 xcconfig）。填一个占位域名比留空更糟：它语法合法，会被静默打进包，用户看到的是
「网络连接失败」而不是"这个包没配地址"——失败点从构建期挪到了用户设备上。留空则第一屏
就是配置缺失说明页。

**依赖注入：`AppLaunch.live()` 一处构造。** URLSession（ephemeral）、`LiveAuthClient`、
`KeychainSessionTokenStore` 都在这里 new 一次往下传，业务代码不就地构造依赖，测试才能换成
假实现。

**分层。** `Views` → `SessionController` / `AuthFormModel`（ViewModel）→ `AuthClient`（网络）
/ `SessionTokenStore`（Keychain）→ `HTTPTransport`。View 里没有网络调用和数据变换；
契约模型集中在 `Contracts/`，据 `packages/contracts` 手写，不另立一套定义。

## 会话凭证

原生客户端走 bearer token，不碰 cookie：

- 注册/登录成功后从 `set-auth-token` 响应头取 token，**原样**存进 Keychain
  （`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`，不进 iCloud、不随备份换设备）——
  只能进 Keychain，这是 `.claude/rules/swift.md` 的 BLOCKER 条款，不是偏好；
- 之后每个请求带 `Authorization: Bearer <token>`；
- 每个请求固定发 `Origin: <api base URL 的源>`；
- URLSession 用 `ephemeral` 且显式关掉 cookie：凭证不落盘，也不会因为带上 `Cookie`
  触发 better-auth 的强制 origin 校验。

服务端那侧是 better-auth 的 bearer plugin（api 已接），跟 web 走的 cookie 路径互不相干：
web 怎么发 cookie 与 iOS 无关，iOS 也不去碰那条路径上的任何东西。响应头名、`Origin` 要求
与各条错误分支都以 `packages/contracts` 里的实测契约为唯一来源，本节只是转述；两边对不上
时以契约为准，不在客户端猜。

token 的形状（`<会话 id>.<标准 base64 签名>`，含 `+` `/` `=`）与"必须原样透传"的理由见
`packages/contracts/src/index.ts`；客户端侧由 `SessionTokenTests` 钉住。

`/api/me` 返回 401 时唯一的动作是清 Keychain 回登录态——不追问原因、不重试。5xx、超时、
限流都**不算**登出，走可重试的错误态，否则一次网络抖动就变成一次莫名其妙的登出。

## 尚未做的

- **没有后端功能开关。** `ios-development` skill 建议涉及契约的新功能配 feature flag，但
  认证是 App 的地基，"关掉登录"不是一个有意义的降级；契约里也没有开关端点。等有了真正
  可降级的业务功能再引入开关机制。
- **离线态没有在真机/弱网下手验过**，只有单元测试覆盖（`TransportFailure.classify`）。
  要手验需要 Network Link Conditioner。
- 没有国际化：文案集中在 `AuthCopy`，要上多语言时整体搬进 String Catalog，不用动 View。
