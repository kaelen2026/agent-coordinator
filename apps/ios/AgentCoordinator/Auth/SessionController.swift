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

        /// 屏幕上是否已经有值得留住的内容。下拉刷新时不该把它换成全屏 spinner——
        /// 那会连列表和滚动位置一起丢掉。
        var hasRetainableContent: Bool {
            switch self {
            case .loaded, .empty: true
            case .loading, .unauthenticated, .failed, .offline: false
            }
        }
    }

    private(set) var state: State
    private(set) var isSigningOut = false
    /// 登出没成功时给用户看的提示。登出失败就是没登出，本地不能假装成功。
    private(set) var signOutFailure: AuthFailure?

    private let client: any AuthClient
    private let tokenStore: any SessionTokenStore
    private let now: DateProvider
    private var isRefreshing = false

    /// 限流窗口的截止时刻，两条失败通道各一个。
    ///
    /// 与 `AuthFormModel.rateLimitedUntil` 同一条原则：存截止时刻而不是秒数——倒计时挂在
    /// 视图生命周期上，离屏 / 切后台被取消再回来是**重启**不是续跑，用秒数当起点就会从头再数。
    /// 这两个值只经下面的计算属性读出去，读时会连着核对对应通道当前确实是限流失败，
    /// 所以不需要在每个赋值点补一次清理（新的限流失败一定连着新的截止时刻一起写）。
    private var stateRateLimitedUntil: Date?
    private var signOutRateLimitedUntil: Date?

    /// 会话代数。本地凭证每变一次（存进新 token、清掉 token）就 +1。
    ///
    /// `isRefreshing` 和 `isSigningOut` 是两把互不相干的锁，只挡各自的重入，挡不住
    /// **不同操作之间**的交错：登出请求先回来清了 Keychain，之后那个还在飞的 `/api/me`
    /// 200 回来，就会把已登出的会话写回已登录态（凭证已删、界面却还在展示账号）。
    /// 所以每个会在 await 之后写 `state` 的路径都要先记下出发时的代数，回来时比一比——
    /// 不一致说明这条会话已经作废，结果直接丢弃。
    private var sessionGeneration = 0

    init(
        client: any AuthClient,
        tokenStore: any SessionTokenStore,
        initialState: State = .loading,
        now: @escaping DateProvider = systemDateProvider
    ) {
        self.client = client
        self.tokenStore = tokenStore
        self.now = now
        state = initialState
    }

    /// 界面态那条限流失败的窗口截止时刻。
    var stateRateLimitDeadline: Date? {
        guard case .failed(.rateLimited) = state else { return nil }
        return stateRateLimitedUntil
    }

    /// 登出失败提示里那条限流的窗口截止时刻。
    var signOutRateLimitDeadline: Date? {
        guard case .rateLimited = signOutFailure else { return nil }
        return signOutRateLimitedUntil
    }

    /// 冷启动的会话守卫，也是错误/离线态的重试入口。
    /// 进行中重复触发直接忽略：下拉刷新和重试按钮都可能被连点，旧结果不该覆盖新结果。
    func refresh() async {
        guard !isRefreshing else { return }
        // 登出还在飞的时候刷新没有意义：结果注定要被丢弃（见 sessionGeneration），
        // 却要白吃一次限流额度。这一条不能替代代数比对——它挡不住"刷新先出发、
        // 登出后出发"那个顺序。
        guard !isSigningOut else { return }

        isRefreshing = true
        defer { isRefreshing = false }

        let generation = sessionGeneration

        // 已经有内容在屏幕上（下拉刷新）就不切全屏加载态；冷启动和错误/离线态重试才切。
        if !state.hasRetainableContent {
            state = .loading
        }

        guard let token = await loadStoredToken() else {
            guard generation == sessionGeneration else { return }
            state = .unauthenticated
            return
        }

        await applyCurrentUser(token: token, generation: generation)
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
            let failure = error.displayFailure
            signOutFailure = failure
            signOutRateLimitedUntil = rateLimitDeadline(for: failure)
        }
    }

    /// 限流失败 → 窗口截止时刻；其他失败没有窗口。
    private func rateLimitDeadline(for failure: AuthFailure) -> Date? {
        guard case let .rateLimited(seconds) = failure else { return nil }
        return now().addingTimeInterval(TimeInterval(seconds))
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

    /// 作废当前会话的本地凭证。无论 Keychain 删没删掉，代数都要 +1：
    /// "这条会话不算数了"是意图，不取决于删除操作的成败。
    ///
    /// 与 `adoptSession` 里那次 +1 是**同一条不变式**的两个入口（凭证的两种变化：清掉 / 换新），
    /// 两边都必须在 `await` 触碰 Keychain **之前**抬高代数——中间那一格窗口里，
    /// 迟到的旧结果会误判自己还属于当前会话。改一边就要改另一边，别把它们拆开。
    private func discardStoredToken() async {
        sessionGeneration += 1
        do {
            try await tokenStore.clear()
        } catch {
            // 删不掉只能记一笔继续：服务端那边会话已经无效，残留值下次 refresh 会拿 401 再清一次。
            AuthLog.storageFailure(operation: "clear-token")
        }
    }

    /// 结果在飞行期间是否还属于当前这条会话。
    private enum SessionApplication {
        case applied
        /// 期间发生了登出 / 换账号：这条结果属于一条已经作废的会话，全部丢弃。
        case superseded
    }

    @discardableResult
    private func applyCurrentUser(token: SessionToken, generation: Int) async -> SessionApplication {
        let result = await client.currentUser(token: token)

        // 回来的第一件事：确认这条会话还是当前那条。放在 switch 之前是刻意的——
        // 迟到的 401 同样不许动新会话的凭证（它说的是旧 token 失效，不是新 token 失效）。
        guard generation == sessionGeneration else { return .superseded }

        switch result {
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
                let failure = error.displayFailure
                state = .failed(failure)
                stateRateLimitedUntil = rateLimitDeadline(for: failure)
            }
        }

        return .applied
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
            // 换了一份凭证 = 换了一条会话：之前所有在飞的请求就此作废。
            //
            // 这两行必须在 `save` 的 await **之前**，理由与 `discardStoredToken` 完全相同
            // （那是同一条不变式的另一个入口）：代数表达的是"从这一刻起换了一条会话"这个**意图**，
            // 不取决于 Keychain 写入的成败与耗时。放在 save 之后会留下一格"新凭证已落盘、
            // 代数尚未抬高"的窗口——迟到的旧 401 在这一格里能通过代数比对，
            // 把刚存进去的新凭证清掉（`staleUnauthorizedDoesNotClearTokenBeingSaved` 钉住这一格）。
            sessionGeneration += 1
            let generation = sessionGeneration

            do {
                try await tokenStore.save(token)
            } catch {
                // 存不下就不是一个能跨启动保持的会话，不能进已登录态假装成功。
                AuthLog.storageFailure(operation: "save-token")
                return .failed(.storageUnavailable)
            }

            guard await applyCurrentUser(token: token, generation: generation) == .applied else {
                // 拉资料期间又发生了登出 / 又一次登录。那次操作更新，界面状态归它管。
                //
                // 之所以能安全地回 authenticated：这个返回值只影响**表单局部呈现**，不驱动路由——
                // `AuthFormModel.submit()` 拿到它只是清密码 + 把 submission 置回 idle，
                // 进哪个页面完全由 `RootView` 读 `session.state` 决定。本次认证请求本身确实成功了，
                // 报一个失败反而会在界面上留下一条与事实不符的错误提示。
                // 若日后给 outcome 加上导航语义（比如"成功就 push 到某页"），这条理由就不成立了，
                // 必须重新判断——那时 superseded 应当有自己的返回值。
                return .authenticated
            }

            // 刚登录就被判未认证：凭证已在 applyCurrentUser 里清掉，如实报失败。
            if state == .unauthenticated {
                return .failed(.remote(.unauthenticated))
            }

            return .authenticated
        }
    }
}
