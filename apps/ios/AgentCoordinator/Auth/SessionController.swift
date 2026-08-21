import Foundation

enum AuthSubmissionFailure: Equatable, Sendable {
    /// 服务端给出的失败（已按契约归类）。
    case remote(AuthFailure)
    /// 拿到了 token 但存不进 Keychain：会话没法跨启动保持，不能假装登录成功。
    case storageUnavailable
}

enum AuthSubmissionOutcome: Equatable, Sendable {
    case authenticated
    case failed(AuthSubmissionFailure)
}

/// 表单只依赖这个接口，不认识网络层与 Keychain（architecture.md：模块间走显式接口）。
@MainActor
protocol AuthenticationPerforming: AnyObject {
    func performSignIn(email: String, password: String) async -> AuthSubmissionOutcome
    func performSignUp(name: String, email: String, password: String) async -> AuthSubmissionOutcome
}

/// 会话状态机。整个 App 的"我是谁 / 有没有登录"只有这一个来源。
@MainActor
@Observable
final class SessionController {
    /// 界面状态显式建模（ios-development skill 步骤 3）：五态各占一个 case，
    /// 不用散落的布尔标志。
    enum State: Equatable {
        case loading
        case unauthenticated
        case loaded(AuthUser)
        /// 服务端 200 但资料没有任何可展示内容 —— 空态，不是错误态。
        case empty(AuthUser)
        case failed(AuthFailure)
        case offline
    }

    private(set) var state: State
    private(set) var isSigningOut = false
    /// 登出没成功时给用户看的提示。登出失败就是没登出，本地不能假装成功。
    private(set) var signOutFailure: AuthFailure?

    private let client: any AuthClient
    private let tokenStore: any SessionTokenStore
    private var isRefreshing = false

    init(client: any AuthClient, tokenStore: any SessionTokenStore, initialState: State = .loading) {
        self.client = client
        self.tokenStore = tokenStore
        state = initialState
    }

    /// 冷启动的会话守卫，也是错误/离线态的重试入口。
    /// 进行中重复触发直接忽略：下拉刷新和重试按钮都可能被连点，旧结果不该覆盖新结果。
    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }

        state = .loading

        guard let token = await loadStoredToken() else {
            state = .unauthenticated
            return
        }

        await applyCurrentUser(token: token)
    }

    func signOut() async {
        guard !isSigningOut else { return }
        isSigningOut = true
        signOutFailure = nil
        defer { isSigningOut = false }

        guard let token = await loadStoredToken() else {
            // 本地已经没有凭证：没什么可撤销的，直接回登录页。
            await discardStoredToken()
            state = .unauthenticated
            return
        }

        switch await client.signOut(token: token) {
        case .signedOut:
            // 契约：token 已失效时服务端也回 200。"已经登出"和"刚刚登出"对用户是同一件事，
            // 不弹失败提示。
            await discardStoredToken()
            state = .unauthenticated
        case let .failed(error):
            signOutFailure = error.displayFailure
        }
    }

    // MARK: - 内部

    private func loadStoredToken() async -> SessionToken? {
        do {
            return try await tokenStore.load()
        } catch {
            // 读不出凭证 = 无法证明有会话，按未登录处理。不 crash、不带 token 进日志。
            AuthLog.storageFailure(operation: "load-token")
            return nil
        }
    }

    private func discardStoredToken() async {
        do {
            try await tokenStore.clear()
        } catch {
            // 删不掉只能记一笔继续：服务端那边会话已经无效，残留值下次 refresh 会拿 401 再清一次。
            AuthLog.storageFailure(operation: "clear-token")
        }
    }

    private func applyCurrentUser(token: SessionToken) async {
        switch await client.currentUser(token: token) {
        case let .success(user):
            state = user.hasDisplayableProfile ? .loaded(user) : .empty(user)
        case let .failure(error):
            AuthLog.requestFailure(operation: "current-user", error: error)

            if error.isSessionGone {
                // 401 的唯一正确反应：清 Keychain 回登录态。不追问原因、不重试。
                await discardStoredToken()
                state = .unauthenticated
            } else if error.isOffline {
                state = .offline
            } else {
                // 网络抖动 / 服务端 5xx / 限流都不等于登出，别把一次抖动变成一次莫名的登出。
                state = .failed(error.displayFailure)
            }
        }
    }
}

extension SessionController: AuthenticationPerforming {
    func performSignIn(email: String, password: String) async -> AuthSubmissionOutcome {
        let normalizedEmail = AuthFormValidation.normalizedEmail(email)
        return await adoptSession {
            await self.client.signIn(email: normalizedEmail, password: password)
        }
    }

    func performSignUp(name: String, email: String, password: String) async -> AuthSubmissionOutcome {
        let normalizedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedEmail = AuthFormValidation.normalizedEmail(email)
        return await adoptSession {
            await self.client.signUp(name: normalizedName, email: normalizedEmail, password: password)
        }
    }

    /// 登录与注册只差一个请求，之后的动作完全相同：存 token → 用同一条会话守卫路径拉资料。
    ///
    /// 刻意**不**从 sign-in/sign-up 的响应体里解用户：`packages/contracts` 只定义了
    /// token 响应头，没有定义这两个端点的成功 body。自己给它编一套 Codable 就等于在客户端
    /// 另立契约（architecture.md：契约唯一来源）。多一次 `/api/me` 换取"会话状态只有一条
    /// 代码路径"，也顺带让登录后的状态和冷启动完全一致。
    private func adoptSession(
        _ authenticate: () async -> Result<SessionToken, AuthRequestError>
    ) async -> AuthSubmissionOutcome {
        switch await authenticate() {
        case let .failure(error):
            AuthLog.requestFailure(operation: "authenticate", error: error)
            return .failed(.remote(error.displayFailure))

        case let .success(token):
            do {
                try await tokenStore.save(token)
            } catch {
                // 存不下就不是一个能跨启动保持的会话，不能进已登录态假装成功。
                AuthLog.storageFailure(operation: "save-token")
                return .failed(.storageUnavailable)
            }

            await applyCurrentUser(token: token)

            // 刚登录就被判未认证：凭证已在 applyCurrentUser 里清掉，如实报失败。
            if state == .unauthenticated {
                return .failed(.remote(.unauthenticated))
            }

            return .authenticated
        }
    }
}
