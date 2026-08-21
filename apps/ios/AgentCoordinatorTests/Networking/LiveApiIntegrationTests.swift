@testable import AgentCoordinator
import Foundation
import Testing

/// 打**真实 api** 的联调测试。默认不跑（需要本地起 api + postgres），
/// 用环境变量显式打开：
///
/// ```
/// pnpm infra:up && pnpm --filter=@agent-coordinator/api dev     # 另一个终端
/// IOS_API_INTEGRATION=1 xcodebuild test -project AgentCoordinator.xcodeproj \
///   -scheme AgentCoordinator -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
///   -only-testing:AgentCoordinatorTests/LiveApiIntegrationTests
/// ```
///
/// 之所以不放进默认套件：它依赖外部进程，放进去会让"测试全绿"变成一句需要前置条件的话
/// （testing.md：测试必须可重复）。它的价值是在合并前把契约里那些实测结论在真机路径上
/// 再验一遍——单元测试只能保证"我按我理解的契约发请求"。
@Suite(
    "真实 api 联调",
    .enabled(if: ProcessInfo.processInfo.environment["IOS_API_INTEGRATION"] == "1"),
    .serialized
)
struct LiveApiIntegrationTests {
    /// better-auth 对 sign-in / sign-up 限流，桶按 `IP|/path` 分（api 侧集成测试钉住的），
    /// 当前配置是每桶每 10 秒 3 次。每次写操作前先隔一下，否则测的就是限流而不是业务。
    private static let authWriteSpacing = Duration.seconds(4)
    private static let password = "correct-horse-battery-staple"

    /// 联调测试必须自己遵守服务端的限流，不然结果不可重复（testing.md）。
    private func paceAuthWrite() async throws {
        try await Task.sleep(for: Self.authWriteSpacing)
    }

    private func makeClient() throws -> (LiveAuthClient, AppConfiguration) {
        let raw = ProcessInfo.processInfo.environment["IOS_API_BASE_URL"] ?? "http://localhost:3001"
        let url = try #require(URL(string: raw))
        let configuration = try AppConfiguration(apiBaseURL: url)
        let transport = URLSessionTransport(session: URLSessionTransport.makeSession())
        return (LiveAuthClient(configuration: configuration, transport: transport), configuration)
    }

    private func uniqueEmail() -> String {
        "ios-it-\(UUID().uuidString.prefix(8).lowercased())@example.com"
    }

    @Test("注册 → /api/me → 登出 → token 失效 → 重新登录 走得通")
    func fullSessionLifecycle() async throws {
        let (client, _) = try makeClient()
        let email = uniqueEmail()

        // 1. 注册：token 必须从 set-auth-token 拿到
        try await paceAuthWrite()
        let signUpToken = try await (client.signUp(name: "IT Probe", email: email, password: Self.password)).get()
        #expect(signUpToken.rawValue.contains("."))

        // 2. 带 bearer 读 /api/me
        let user = try await (client.currentUser(token: signUpToken)).get()
        #expect(user.email == email)
        #expect(user.name == "IT Probe")

        // 3. 把签名截掉只留裸会话 id —— 服务端开了 requireSignature，必须被拒
        let bareID = try #require(signUpToken.rawValue.split(separator: ".").first)
        let bareToken = try #require(SessionToken(rawValue: String(bareID)))
        let bareResult = await client.currentUser(token: bareToken)
        #expect(bareResult == .failure(.failure(.unauthenticated)))

        // 4. 登出
        #expect(await client.signOut(token: signUpToken) == .signedOut)

        // 5. 登出后同一个 token 变成 401
        #expect(await client.currentUser(token: signUpToken) == .failure(.failure(.unauthenticated)))

        // 6. 幂等：拿已失效的 token 再登出一次，仍然是成功
        #expect(await client.signOut(token: signUpToken) == .signedOut)

        // 7. 重新登录拿到新 token，同一个账号照旧可用
        try await paceAuthWrite()
        let signInToken = try await (client.signIn(email: email, password: Self.password)).get()
        #expect(signInToken.rawValue != signUpToken.rawValue)
        let reloaded = try await (client.currentUser(token: signInToken)).get()
        #expect(reloaded.id == user.id)

        // 8. 密码错 → 401 invalid-credentials（不区分账号不存在与密码错）
        try await paceAuthWrite()
        #expect(await client.signIn(email: email, password: "definitely-wrong-password")
            == .failure(.failure(.invalidCredentials)))

        // 9. 重复邮箱 → 422 email-taken
        try await paceAuthWrite()
        #expect(await client.signUp(name: "IT Probe", email: email, password: Self.password)
            == .failure(.failure(.emailTaken)))

        // 10. 不存在的账号与密码错的响应完全一致
        try await paceAuthWrite()
        #expect(await client.signIn(email: uniqueEmail(), password: Self.password)
            == .failure(.failure(.invalidCredentials)))
    }

    @Test("密码太短被服务端拒（客户端校验之外的第二道）")
    func shortPasswordIsRejectedByServer() async throws {
        let (client, _) = try makeClient()
        try await paceAuthWrite()

        let result = await client.signUp(name: "IT Probe", email: uniqueEmail(), password: "short")

        #expect(result == .failure(.failure(.invalidInput(.passwordTooShort))))
    }

    @Test("Origin 矩阵：api 自己的源通过，自己编的源 403 INVALID_ORIGIN")
    func originMatrixHoldsOnLiveApi() async throws {
        let (_, configuration) = try makeClient()
        let transport = URLSessionTransport(session: URLSessionTransport.makeSession())
        let body = Data(#"{"email":"nobody@example.com","password":"whatever-long-enough"}"#.utf8)

        // 客户端固定发的那个 Origin：能过 origin 校验（会因为账号不存在拿 401，不是 403）
        try await paceAuthWrite()
        let trusted = try await transport.send(HTTPRequest(
            method: .post,
            url: configuration.url(path: AuthEndpoint.signIn),
            headers: [
                AuthHeaderName.contentType: "application/json",
                AuthHeaderName.origin: configuration.originHeaderValue,
            ],
            body: body
        ))
        #expect(trusted.status != 403)

        // 自己编的 origin：403 INVALID_ORIGIN —— 这就是不要发自定义 scheme 的原因
        try await paceAuthWrite()
        let untrusted = try await transport.send(HTTPRequest(
            method: .post,
            url: configuration.url(path: AuthEndpoint.signIn),
            headers: [
                AuthHeaderName.contentType: "application/json",
                AuthHeaderName.origin: "http://evil.example.com",
            ],
            body: body
        ))
        #expect(untrusted.status == 403)
        let failure = AuthFailureClassifier.classifyBetterAuth(
            status: untrusted.status,
            body: untrusted.body,
            headers: untrusted.headers
        )
        #expect(failure == .forbidden(code: "INVALID_ORIGIN"))
    }

    @Test("完全不带凭证的 /api/me 与带坏 token 的响应一致（都是 401 UNAUTHENTICATED）")
    func unauthenticatedResponsesAreIndistinguishable() async throws {
        let (_, configuration) = try makeClient()
        let transport = URLSessionTransport(session: URLSessionTransport.makeSession())

        let noCredentials = try await transport.send(HTTPRequest(
            method: .get,
            url: configuration.url(path: AuthEndpoint.currentUser),
            headers: [AuthHeaderName.origin: configuration.originHeaderValue],
            body: nil
        ))
        let forgedToken = try await transport.send(HTTPRequest(
            method: .get,
            url: configuration.url(path: AuthEndpoint.currentUser),
            headers: [
                AuthHeaderName.origin: configuration.originHeaderValue,
                AuthHeaderName.authorization: "Bearer forged.signature=",
            ],
            body: nil
        ))

        #expect(noCredentials.status == 401)
        #expect(forgedToken.status == 401)
        #expect(noCredentials.body == forgedToken.body)
    }
}
