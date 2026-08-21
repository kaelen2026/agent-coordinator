@testable import AgentCoordinator
import Foundation
import Testing

@Suite("LiveAuthClient：按契约发请求、按契约读响应")
struct LiveAuthClientTests {
    private func makeClient(_ transport: FakeHTTPTransport) throws -> LiveAuthClient {
        try LiveAuthClient(configuration: TestFixtures.configuration(), transport: transport)
    }

    private func decodeBody(_ request: HTTPRequest?) throws -> [String: String] {
        let data = try #require(request?.body)
        let raw = try JSONSerialization.jsonObject(with: data)
        let object = try #require(raw as? [String: Any])
        return object.compactMapValues { $0 as? String }
    }

    private static func serverError(_ status: Int = 500) -> FakeHTTPTransport.Step {
        .respond(HTTPResponse(status: status, headers: HTTPHeaders([:]), body: Data()))
    }

    // MARK: - 请求构造

    @Test("sign-in 打的是契约里的路径和方法")
    func signInTargetsContractEndpoint() async throws {
        let transport = FakeHTTPTransport(status: 500)
        let client = try makeClient(transport)

        _ = await client.signIn(email: "a@b.co", password: "pw")

        let request = try #require(transport.lastRequest)
        #expect(request.method == .post)
        #expect(request.url.absoluteString == "http://localhost:3001/api/auth/sign-in/email")
        #expect(request.headers[AuthHeaderName.contentType] == "application/json")
    }

    @Test("sign-up 打的是契约里的路径，body 带 name/email/password")
    func signUpSendsContractBody() async throws {
        let transport = FakeHTTPTransport(status: 500)
        let client = try makeClient(transport)

        _ = await client.signUp(name: "Founder", email: "a@b.co", password: "pw123456789012")

        let request = try #require(transport.lastRequest)
        #expect(request.url.absoluteString == "http://localhost:3001/api/auth/sign-up/email")
        let body = try decodeBody(request)
        #expect(body == ["name": "Founder", "email": "a@b.co", "password": "pw123456789012"])
    }

    @Test("固定发 Origin = api 自己的源（契约第 4 节；不发或自己编都不行）")
    func alwaysSendsApiOriginHeader() async throws {
        let transport = FakeHTTPTransport(steps: [
            Self.serverError(), Self.serverError(), Self.serverError(), Self.serverError(),
        ])
        let client = try makeClient(transport)
        let token = try TestFixtures.token()

        _ = await client.signIn(email: "a@b.co", password: "pw")
        _ = await client.signUp(name: "n", email: "a@b.co", password: "pw")
        _ = await client.signOut(token: token)
        _ = await client.currentUser(token: token)

        #expect(transport.requestCount == 4)
        for index in 0 ..< 4 {
            let headers = try #require(transport.request(at: index)?.headers)
            #expect(headers[AuthHeaderName.origin] == "http://localhost:3001", "request \(index)")
        }
    }

    @Test("从不带 Cookie 头：带上就会触发 better-auth 的强制 origin 校验")
    func neverSendsCookieHeader() async throws {
        let transport = FakeHTTPTransport(status: 500)
        let client = try makeClient(transport)

        _ = await client.signIn(email: "a@b.co", password: "pw")

        let headers = try #require(transport.lastRequest?.headers)
        #expect(headers.keys.allSatisfy { $0.lowercased() != "cookie" })
    }

    @Test("sign-in/sign-up 不带 Authorization：还没有 token")
    func doesNotSendAuthorizationOnSignIn() async throws {
        let transport = FakeHTTPTransport(status: 500)
        let client = try makeClient(transport)

        _ = await client.signIn(email: "a@b.co", password: "pw")

        #expect(transport.lastRequest?.headers[AuthHeaderName.authorization] == nil)
    }

    @Test("/api/me 用 GET + Bearer，token 原样带上")
    func currentUserSendsBearerVerbatim() async throws {
        let raw = ContractSamples.sessionTokenWithPlusAndSlashRaw
        let transport = FakeHTTPTransport(status: 401, body: ContractSamples.apiError(code: "UNAUTHENTICATED"))
        let client = try makeClient(transport)

        _ = try await client.currentUser(token: TestFixtures.token(raw))

        let request = try #require(transport.lastRequest)
        #expect(request.method == .get)
        #expect(request.url.absoluteString == "http://localhost:3001/api/me")
        #expect(request.headers[AuthHeaderName.authorization] == "Bearer \(raw)")
        let authorization = try #require(request.headers[AuthHeaderName.authorization])
        #expect(!authorization.contains("%2B"))
        #expect(!authorization.contains("%2F"))
        #expect(request.body == nil)
    }

    @Test("sign-out 用 POST + Bearer，打契约里的路径")
    func signOutSendsBearer() async throws {
        let transport = FakeHTTPTransport(status: 200)
        let client = try makeClient(transport)
        let token = try TestFixtures.token()

        _ = await client.signOut(token: token)

        let request = try #require(transport.lastRequest)
        #expect(request.method == .post)
        #expect(request.url.absoluteString == "http://localhost:3001/api/auth/sign-out")
        #expect(request.headers[AuthHeaderName.authorization] == token.authorizationHeaderValue)
    }

    @Test("sign-out 必须带 application/json 和一个 JSON body")
    func signOutSendsJSONContentTypeAndBody() async throws {
        // 实测（本地 api，feat/auth-bearer）：
        //   不带 Content-Type          → 415 UNSUPPORTED_MEDIA_TYPE
        //   带 Content-Type 但 body 空 → 400 BAD_REQUEST "Invalid JSON in request body"
        //   带 Content-Type + `{}`     → 200 {"success":true}
        let transport = FakeHTTPTransport(status: 200)
        let client = try makeClient(transport)

        _ = try await client.signOut(token: TestFixtures.token())

        let request = try #require(transport.lastRequest)
        #expect(request.headers[AuthHeaderName.contentType] == "application/json")
        let body = try #require(request.body)
        let decoded = try JSONSerialization.jsonObject(with: body)
        #expect(decoded is [String: Any])
    }

    // MARK: - 成功路径

    @Test("sign-in 200：从 set-auth-token 取 token，原样存下")
    func signInReadsTokenFromContractHeader() async throws {
        let raw = ContractSamples.sessionTokenRaw
        // 服务端实际下发的是全小写头名
        let transport = FakeHTTPTransport(status: 200, headers: ["set-auth-token": raw], body: Data("{}".utf8))
        let client = try makeClient(transport)

        let result = await client.signIn(email: "a@b.co", password: "pw")

        let token = try result.get()
        #expect(token.rawValue == raw)
    }

    @Test("sign-up 200：同样从 set-auth-token 取")
    func signUpReadsTokenFromContractHeader() async throws {
        let raw = ContractSamples.sessionTokenWithPlusAndSlashRaw
        let transport = FakeHTTPTransport(status: 200, headers: ["Set-Auth-Token": raw], body: Data("{}".utf8))
        let client = try makeClient(transport)

        let result = await client.signUp(name: "n", email: "a@b.co", password: "pw")

        let token = try result.get()
        #expect(token.rawValue == raw)
    }

    @Test("200 但没有 set-auth-token：不假装成功，归为 unexpected")
    func missingTokenHeaderIsUnexpected() async throws {
        let transport = FakeHTTPTransport(status: 200, body: Data("{}".utf8))
        let client = try makeClient(transport)

        let result = await client.signIn(email: "a@b.co", password: "pw")

        #expect(result == .failure(.failure(.unexpected(status: 200))))
    }

    @Test("200 但 set-auth-token 是空白：同样不接受")
    func blankTokenHeaderIsUnexpected() async throws {
        let transport = FakeHTTPTransport(status: 200, headers: ["set-auth-token": "   "], body: Data("{}".utf8))
        let client = try makeClient(transport)

        let result = await client.signIn(email: "a@b.co", password: "pw")

        #expect(result == .failure(.failure(.unexpected(status: 200))))
    }

    @Test("/api/me 200 解出用户")
    func currentUserDecodesUser() async throws {
        let transport = FakeHTTPTransport(status: 200, body: ContractSamples.meResponse)
        let client = try makeClient(transport)

        let result = try await client.currentUser(token: TestFixtures.token())

        #expect(try result.get() == TestFixtures.user)
    }

    @Test("/api/me 200 但 body 解不出来：归为 unexpected，不 crash")
    func currentUserRejectsGarbageBody() async throws {
        let transport = FakeHTTPTransport(status: 200, body: ContractSamples.notJSON)
        let client = try makeClient(transport)

        let result = try await client.currentUser(token: TestFixtures.token())

        #expect(result == .failure(.failure(.unexpected(status: 200))))
    }

    // MARK: - 错误分支（契约实测表）

    @Test("sign-in 401 → 凭证错")
    func signInInvalidCredentials() async throws {
        let transport = FakeHTTPTransport(
            status: 401,
            body: ContractSamples.betterAuthError(code: "INVALID_EMAIL_OR_PASSWORD")
        )
        let client = try makeClient(transport)

        let result = await client.signIn(email: "a@b.co", password: "pw")

        #expect(result == .failure(.failure(.invalidCredentials)))
    }

    @Test("sign-up 422 → 邮箱已注册")
    func signUpEmailTaken() async throws {
        let transport = FakeHTTPTransport(
            status: 422,
            body: ContractSamples.betterAuthError(code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL")
        )
        let client = try makeClient(transport)

        let result = await client.signUp(name: "n", email: "a@b.co", password: "pw")

        #expect(result == .failure(.failure(.emailTaken)))
    }

    @Test("sign-up 403 INVALID_ORIGIN → forbidden（带 code 便于排查部署）")
    func signUpForbiddenOrigin() async throws {
        let transport = FakeHTTPTransport(status: 403, body: ContractSamples.betterAuthError(code: "INVALID_ORIGIN"))
        let client = try makeClient(transport)

        let result = await client.signUp(name: "n", email: "a@b.co", password: "pw")

        #expect(result == .failure(.failure(.forbidden(code: "INVALID_ORIGIN"))))
    }

    @Test("sign-in 400 PASSWORD_TOO_SHORT → 字段校验错")
    func signInPasswordTooShort() async throws {
        let transport = FakeHTTPTransport(
            status: 400,
            body: ContractSamples.betterAuthError(code: "PASSWORD_TOO_SHORT")
        )
        let client = try makeClient(transport)

        let result = await client.signIn(email: "a@b.co", password: "pw")

        #expect(result == .failure(.failure(.invalidInput(.passwordTooShort))))
    }

    @Test("sign-in 429 读 X-Retry-After")
    func signInRateLimited() async throws {
        let transport = FakeHTTPTransport(
            status: 429,
            headers: ["x-retry-after": "10"],
            body: ContractSamples.betterAuthErrorWithoutCode
        )
        let client = try makeClient(transport)

        let result = await client.signIn(email: "a@b.co", password: "pw")

        #expect(result == .failure(.failure(.rateLimited(retryAfterSeconds: 10))))
    }

    @Test("/api/me 429 读 Retry-After（自有端点，头名不同）")
    func currentUserRateLimited() async throws {
        let transport = FakeHTTPTransport(
            status: 429,
            headers: ["retry-after": "45"],
            body: ContractSamples.apiError(code: "RATE_LIMITED")
        )
        let client = try makeClient(transport)

        let result = try await client.currentUser(token: TestFixtures.token())

        #expect(result == .failure(.failure(.rateLimited(retryAfterSeconds: 45))))
    }

    @Test("/api/me 401 → unauthenticated（不区分原因）")
    func currentUserUnauthenticated() async throws {
        let transport = FakeHTTPTransport(status: 401, body: ContractSamples.apiError(code: "UNAUTHENTICATED"))
        let client = try makeClient(transport)

        let result = try await client.currentUser(token: TestFixtures.token())

        #expect(result == .failure(.failure(.unauthenticated)))
    }

    @Test("断网时归为 transport(.offline)，不冒充服务端错误")
    func transportOfflineIsReported() async throws {
        let transport = FakeHTTPTransport(failure: .offline)
        let client = try makeClient(transport)

        let result = try await client.currentUser(token: TestFixtures.token())

        #expect(result == .failure(.transport(.offline)))
        #expect(result.failureOrNil?.isOffline == true)
        #expect(result.failureOrNil?.displayFailure == .network)
    }

    // MARK: - 登出的幂等语义

    @Test("sign-out 200 → 已登出")
    func signOutSucceeds() async throws {
        let transport = FakeHTTPTransport(status: 200)
        let client = try makeClient(transport)

        let outcome = try await client.signOut(token: TestFixtures.token())

        #expect(outcome == .signedOut)
    }

    @Test("sign-out 带已失效 token 服务端也回 200：照样算登出成功，且不下发新 token")
    func signOutWithStaleTokenIsIdempotent() async throws {
        // 契约实测：`sign-out` 带已失效 token → 200，不下发新 token
        let transport = FakeHTTPTransport(status: 200, body: Data("{}".utf8))
        let client = try makeClient(transport)

        let outcome = try await client.signOut(token: TestFixtures.token())

        #expect(outcome == .signedOut)
    }

    @Test("sign-out 401 → 会话本来就没了，也算登出成功（不给用户弹失败）")
    func signOutTreats401AsSignedOut() async throws {
        let transport = FakeHTTPTransport(status: 401, body: ContractSamples.apiError(code: "UNAUTHENTICATED"))
        let client = try makeClient(transport)

        let outcome = try await client.signOut(token: TestFixtures.token())

        #expect(outcome == .signedOut)
    }

    @Test("sign-out 5xx → 没登出，保留会话让用户重试")
    func signOutServerErrorIsFailure() async throws {
        let transport = FakeHTTPTransport(status: 503)
        let client = try makeClient(transport)

        let outcome = try await client.signOut(token: TestFixtures.token())

        #expect(outcome == .failed(.failure(.server(status: 503))))
    }

    @Test("sign-out 断网 → 没登出")
    func signOutOfflineIsFailure() async throws {
        let transport = FakeHTTPTransport(failure: .offline)
        let client = try makeClient(transport)

        let outcome = try await client.signOut(token: TestFixtures.token())

        #expect(outcome == .failed(.transport(.offline)))
    }

    @Test("sign-out 被限流 → 没登出，且带上等待秒数")
    func signOutRateLimitedIsFailure() async throws {
        let transport = FakeHTTPTransport(
            status: 429,
            headers: ["x-retry-after": "10"],
            body: ContractSamples.betterAuthErrorWithoutCode
        )
        let client = try makeClient(transport)

        let outcome = try await client.signOut(token: TestFixtures.token())

        #expect(outcome == .failed(.failure(.rateLimited(retryAfterSeconds: 10))))
    }
}

extension Result where Failure == AuthRequestError {
    var failureOrNil: AuthRequestError? {
        switch self {
        case .success: nil
        case let .failure(error): error
        }
    }
}
