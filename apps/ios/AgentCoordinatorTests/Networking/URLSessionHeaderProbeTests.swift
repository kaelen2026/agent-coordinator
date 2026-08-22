@testable import AgentCoordinator
import Foundation
import Testing

/// **实测** App 真正发出去的那份请求带了哪些头。
///
/// 起因：`packages/contracts` 第 4 节里，"原生客户端两条都不沾"这条结论有一半是推断的——
/// `Origin` 不自动发是实测过的，而 `Sec-Fetch-*` / `Referer` 不自动发只是按 Fetch 规范
/// （那是**浏览器**的规范）推的，本仓库从没验证过。
///
/// 这条推断的风险不对称：api 侧实测过，`Sec-Fetch-Site: cross-site` +
/// `Sec-Fetch-Mode: navigate` 会在**校验 Origin 之前**就 403 `CROSS_SITE_NAVIGATION_LOGIN_BLOCKED`，
/// 可信 Origin 也救不回来。所以只要 iOS 的网络层（或某个 iOS 版本、某个企业代理）补上这几个头，
/// 线上表现就是 sign-in 全量 403，而客户端不可热修。
///
/// 于是这里用**本 App 的** `URLSessionTransport` + `LiveAuthClient`（不是另起一个裸
/// URLSession——要验的就是我们实际发出去的那一份）打一个进程内的回显服务器，
/// 断言在网络字节上。
///
/// 实测环境：Xcode 26.6 (17F113) / iOS Simulator 26.5 / iPhone 17 Pro。
/// `Sec-Fetch-*` 是平台行为、会随版本变，所以这套探针留在默认 scheme 里每次 CI 都跑。
@Suite("URLSession 实际发出的请求头（本地探针实测）")
struct URLSessionHeaderProbeTests {
    /// 浏览器会自动补、而 better-auth 会据此收紧校验的那些头。一个都不许出现。
    private static let forbiddenHeaders = [
        "sec-fetch-site",
        "sec-fetch-mode",
        "sec-fetch-dest",
        "sec-fetch-user",
        "referer",
        "cookie",
    ]

    private func expectNoFetchMetadata(_ captured: LoopbackEchoServer.CapturedRequest) {
        for name in Self.forbiddenHeaders {
            #expect(
                captured.header(name) == nil,
                "\(name) 不该出现。实测到的头：\(captured.headerNames)"
            )
        }
        // 连未来新增的 `Sec-*`（Sec-Purpose、Sec-CH-* ……）一起挡住：
        // better-auth 的 origin 校验分支盯的是整个 fetch metadata 家族。
        let secHeaders = captured.headerNames.filter { $0.hasPrefix("sec-") }
        #expect(secHeaders.isEmpty, "出现了 Sec-* 头：\(secHeaders)")
    }

    @Test("sign-in（POST）：只发 Origin，不发 Sec-Fetch-* / Referer / Cookie")
    func signInRequestCarriesNoFetchMetadata() async throws {
        let server = try LoopbackEchoServer()
        try await server.start()
        defer { server.stop() }

        let configuration = try AppConfiguration(apiBaseURL: server.baseURL())
        let client = LiveAuthClient(
            configuration: configuration,
            transport: URLSessionTransport(session: URLSessionTransport.makeSession())
        )

        // 回显服务器不下发 set-auth-token，所以这次调用注定失败；要看的是它发出去的字节。
        _ = await client.signIn(email: "probe@example.com", password: "correct-horse-battery-staple")
        let captured = await server.nextRequest()
        print("PROBE sign-in requestLine=\(captured.requestLine)")
        print("PROBE sign-in headers=\(captured.headerNames)")

        #expect(captured.requestLine == "POST \(AuthEndpoint.signIn) HTTP/1.1")
        // 契约要求发的那一个：api 自己的源，逐字相同。
        #expect(captured.header("origin") == configuration.originHeaderValue)
        #expect(captured.header("content-type") == "application/json")
        expectNoFetchMetadata(captured)
    }

    @Test("/api/me（GET，带 bearer）：同样不发 Sec-Fetch-* / Referer / Cookie")
    func currentUserRequestCarriesNoFetchMetadata() async throws {
        let server = try LoopbackEchoServer()
        try await server.start()
        defer { server.stop() }

        let configuration = try AppConfiguration(apiBaseURL: server.baseURL())
        let client = LiveAuthClient(
            configuration: configuration,
            transport: URLSessionTransport(session: URLSessionTransport.makeSession())
        )
        let token = try TestFixtures.token()

        _ = await client.currentUser(token: token)
        let captured = await server.nextRequest()
        print("PROBE /api/me requestLine=\(captured.requestLine)")
        print("PROBE /api/me headers=\(captured.headerNames)")

        #expect(captured.requestLine == "GET \(AuthEndpoint.currentUser) HTTP/1.1")
        #expect(captured.header("origin") == configuration.originHeaderValue)
        // token 原样透传（含 base64 的 `+` `/` `=`），不许被任何一层编码加工。
        #expect(captured.header("authorization") == "Bearer \(token.rawValue)")
        expectNoFetchMetadata(captured)
    }
}
