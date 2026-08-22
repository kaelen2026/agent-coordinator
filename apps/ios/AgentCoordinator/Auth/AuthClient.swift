import Foundation

/// 契约里用到的端点。路径集中在这里，业务代码不散写字符串。
enum AuthEndpoint {
    static let signUp = "/api/auth/sign-up/email"
    static let signIn = "/api/auth/sign-in/email"
    static let signOut = "/api/auth/sign-out"
    static let currentUser = "/api/me"
}

/// 请求失败：要么拿到了响应但是错误状态（已按契约归类），要么根本没拿到响应。
enum AuthRequestError: Error, Equatable, Sendable {
    case failure(AuthFailure)
    case transport(TransportFailure)

    /// 给用户看的分类。传输失败统一按"网络问题"呈现（与 web 的 `networkFailure()` 对齐）。
    var displayFailure: AuthFailure {
        switch self {
        case let .failure(failure): failure
        case .transport: .network
        }
    }

    /// 只有"设备确实没网"才走离线态；其余传输失败走可重试的错误态。
    var isOffline: Bool {
        self == .transport(.offline)
    }

    /// 会话已经不成立（服务端明确说未认证）——唯一正确反应是清 Keychain 回登录态。
    var isSessionGone: Bool {
        self == .failure(.unauthenticated)
    }
}

/// 登出结果。契约：`sign-out` 带已失效 token 也返回 200（幂等），所以"已经登出"和
/// "刚刚登出"对客户端是同一件事，不该给用户弹"登出失败"。
enum SignOutOutcome: Equatable, Sendable {
    /// 200，或服务端明确说会话已不存在 —— 两者都意味着可以清本地凭证。
    case signedOut
    /// 没能确认登出（网络/5xx/限流）：本地凭证**不清**，让用户重试。
    /// 登出失败就是没登出，本地清个状态假装成功会让用户以为自己安全了。
    case failed(AuthRequestError)
}

protocol AuthClient: Sendable {
    func signUp(name: String, email: String, password: String) async -> Result<SessionToken, AuthRequestError>
    func signIn(email: String, password: String) async -> Result<SessionToken, AuthRequestError>
    func signOut(token: SessionToken) async -> SignOutOutcome
    func currentUser(token: SessionToken) async -> Result<AuthUser, AuthRequestError>
}

struct LiveAuthClient: AuthClient {
    private let configuration: AppConfiguration
    private let transport: any HTTPTransport
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(configuration: AppConfiguration, transport: any HTTPTransport) {
        self.configuration = configuration
        self.transport = transport
    }

    // MARK: - 请求体

    private struct SignUpBody: Encodable {
        let name: String
        let email: String
        let password: String
    }

    private struct SignInBody: Encodable {
        let email: String
        let password: String
    }

    // MARK: - 公开接口

    func signUp(name: String, email: String, password: String) async -> Result<SessionToken, AuthRequestError> {
        await authenticate(path: AuthEndpoint.signUp, body: SignUpBody(name: name, email: email, password: password))
    }

    func signIn(email: String, password: String) async -> Result<SessionToken, AuthRequestError> {
        await authenticate(path: AuthEndpoint.signIn, body: SignInBody(email: email, password: password))
    }

    func signOut(token: SessionToken) async -> SignOutOutcome {
        var headers = authenticatedHeaders(token: token)
        // sign-out 没有业务参数，但服务端仍然要求一个 JSON 请求（实测本地 api）：
        //   不带 Content-Type          → 415 UNSUPPORTED_MEDIA_TYPE
        //   带 Content-Type 但 body 空 → 400 BAD_REQUEST "Invalid JSON in request body"
        //   带 Content-Type + `{}`     → 200 {"success":true}
        headers[AuthHeaderName.contentType] = "application/json"

        let request = HTTPRequest(
            method: .post,
            url: configuration.url(path: AuthEndpoint.signOut),
            headers: headers,
            body: Data("{}".utf8)
        )

        let response: HTTPResponse
        do {
            response = try await transport.send(request)
        } catch {
            return .failed(.transport(TransportFailure.classify(error)))
        }

        // 契约：带已失效 token 的 sign-out 同样返回 200（幂等），不下发新 token。
        // 401 只可能意味着会话已经不在了 —— 对用户来说和登出成功没有区别。
        if (200 ..< 300).contains(response.status) || response.status == 401 {
            return .signedOut
        }

        return .failed(.failure(AuthFailureClassifier.classifyBetterAuth(
            status: response.status,
            body: response.body,
            headers: response.headers
        )))
    }

    func currentUser(token: SessionToken) async -> Result<AuthUser, AuthRequestError> {
        let request = HTTPRequest(
            method: .get,
            url: configuration.url(path: AuthEndpoint.currentUser),
            headers: authenticatedHeaders(token: token),
            body: nil
        )

        let response: HTTPResponse
        do {
            response = try await transport.send(request)
        } catch {
            return .failure(.transport(TransportFailure.classify(error)))
        }

        guard (200 ..< 300).contains(response.status) else {
            // 自有端点用 apiErrorSchema（不是 better-auth 那套）
            return .failure(.failure(AuthFailureClassifier.classifyApi(
                status: response.status,
                body: response.body,
                headers: response.headers
            )))
        }

        guard let decoded = try? decoder.decode(MeResponse.self, from: response.body) else {
            // 2xx 但 body 不符合契约：不猜、不 crash，当成"意外响应"让 UI 走可重试的错误态。
            return .failure(.failure(.unexpected(status: response.status)))
        }

        return .success(decoded.user)
    }

    // MARK: - 内部

    private func authenticate(path: String, body: some Encodable) async -> Result<SessionToken, AuthRequestError> {
        guard let payload = try? encoder.encode(body) else {
            // 自己构造的 body 编不出来只可能是编程错误，不该把它伪装成服务端问题。
            return .failure(.failure(.unexpected(status: 0)))
        }

        var headers = baseHeaders()
        headers[AuthHeaderName.contentType] = "application/json"

        let request = HTTPRequest(method: .post, url: configuration.url(path: path), headers: headers, body: payload)

        let response: HTTPResponse
        do {
            response = try await transport.send(request)
        } catch {
            return .failure(.transport(TransportFailure.classify(error)))
        }

        guard (200 ..< 300).contains(response.status) else {
            return .failure(.failure(AuthFailureClassifier.classifyBetterAuth(
                status: response.status,
                body: response.body,
                headers: response.headers
            )))
        }

        // 契约第 1 节：sign-up / sign-in 的成功响应必带 `set-auth-token`。
        // 真没有就说明服务端行为变了 —— 宁可报错也不进一个没有凭证的"已登录"态。
        guard let raw = response.headers.value(for: AuthHeaderName.sessionToken),
              let token = SessionToken(rawValue: raw)
        else { return .failure(.failure(.unexpected(status: response.status))) }

        return .success(token)
    }

    /// 每个请求都带的头。
    ///
    /// `Origin` 固定发 api 自己的源（契约第 4 节）：better-auth 恒把 `baseURL` 的源放进
    /// trustedOrigins，所以这个值在"强制校验 origin"和"不校验"两条分支下都通得过，
    /// 比"什么都不发"更抗库升级。刻意**不带** `Cookie`：一旦带上，origin/CSRF 校验会
    /// 无条件生效，而原生客户端走的是 bearer。
    private func baseHeaders() -> [String: String] {
        [AuthHeaderName.origin: configuration.originHeaderValue]
    }

    private func authenticatedHeaders(token: SessionToken) -> [String: String] {
        var headers = baseHeaders()
        headers[AuthHeaderName.authorization] = token.authorizationHeaderValue
        return headers
    }
}
