import Foundation

/// 单个认证表单的状态。校验、提交中、失败提示都归它；会话状态归 `SessionController`。
@MainActor
@Observable
final class AuthFormModel {
    enum Mode: Equatable, Sendable {
        case signIn
        case signUp
    }

    enum Submission: Equatable {
        case idle
        case submitting
        case failed(AuthSubmissionFailure)
    }

    let mode: Mode
    var name = ""
    var email = ""
    var password = ""

    private(set) var fieldErrors: [AuthFormField: String] = [:]
    private(set) var submission: Submission = .idle

    /// 限流窗口的**截止时刻**，读在**单调时钟**上（`MonotonicClock`）。
    ///
    /// 刻意存截止时间而不是剩余秒数：秒数只有配合"从什么时候开始数"才有意义，而倒计时是挂在
    /// 视图生命周期上的（`.task` 在离屏 / 切后台时被取消，回来是**重启**不是续跑）。用倒计时
    /// 当窗口的唯一出口，切个后台回来就要从头再数一遍，封锁时长会超过服务端给的窗口——
    /// 那是在惩罚用户。截止时刻与视图在不在场无关。
    ///
    /// 之所以是单调时钟而不是墙钟：见 `MonotonicClock` 的说明——墙钟能被用户改，
    /// 往回一拨就把 60 秒的窗口变成一天。
    ///
    /// 恒等式：它只在 `submission` 是限流失败时非 nil，靠 `setSubmission` 一处维护，
    /// 避免"提示是这个错、窗口是那个错"的两份真相。
    private(set) var rateLimitedUntil: ContinuousClock.Instant?

    private let authenticator: any AuthenticationPerforming
    private let now: MonotonicClock

    init(
        mode: Mode,
        authenticator: any AuthenticationPerforming,
        now: @escaping MonotonicClock = systemMonotonicClock
    ) {
        self.mode = mode
        self.authenticator = authenticator
        self.now = now
    }

    var isSubmitting: Bool {
        submission == .submitting
    }

    /// 提交按钮该不该被禁用。与 web 基线同一条规则
    /// （`apps/web/src/components/auth/sign-in-form.tsx`:
    /// `blocked = state.submitting || state.failure?.kind === "rate-limited"`）：
    /// 限流窗口里再点也只会继续吃 429，把窗口越拖越长。
    var isSubmitBlocked: Bool {
        isSubmitting || isRateLimited
    }

    /// 限流窗口是否还没过去。与倒计时视图在不在场无关。
    ///
    /// 刻意由 `rateLimitRetryAfterSeconds` 派生而不是自己比一次截止时刻：两个读点必须
    /// 说同一件事——"界面显示还要等 N 秒"和"提交被挡着"不能各判各的
    /// （`RateLimitWindow` 的上限不变式于是对两者同时成立）。
    var isRateLimited: Bool {
        rateLimitRetryAfterSeconds != nil
    }

    var failureMessage: String? {
        guard case let .failed(failure) = submission else { return nil }
        switch failure {
        case let .remote(remote): return AuthCopy.message(for: remote)
        case .storageUnavailable: return AuthCopy.storageUnavailable
        }
    }

    /// 还要等几秒，供界面倒计时。由截止时刻实时算出来，所以切后台再回来拿到的是**剩余**
    /// 秒数而不是重新开始的整段窗口；窗口已经过去就是 nil。
    var rateLimitRetryAfterSeconds: Int? {
        guard let rateLimitedUntil else { return nil }
        return RateLimitWindow.secondsRemaining(until: rateLimitedUntil, now: now())
    }

    func submit() async {
        // 进行中重复点击直接忽略：连点两次注册会白吃限流额度，也可能建出两次请求。
        // 限流窗口内同样一个请求都不发——界面禁用了按钮只是第一道，状态层自己也要挡住，
        // 否则一次注定 429 的请求会把窗口继续拖长。
        guard !isSubmitBlocked else { return }

        let errors = validate()
        fieldErrors = errors
        guard errors.isEmpty else {
            setSubmission(.idle)
            return
        }

        setSubmission(.submitting)

        switch await performRequest() {
        case .authenticated:
            // 成功后不把密码留在内存里
            password = ""
            setSubmission(.idle)
        case let .failed(failure):
            setSubmission(.failed(failure))
        }
    }

    /// 用户改动输入时把上一次的失败提示收掉，避免旧错误挂在新输入上。
    ///
    /// **限流是例外**：它说的是"这个 IP 这段时间内不许再来"，跟输入内容无关，改个字符
    /// 并不会让服务端放行。抹掉倒计时只会诱导用户再点一次、再吃一次 429。
    /// web 表单非受控、编辑不清 failure，同一口径。
    func clearFailure() {
        guard !isRateLimited else { return }
        if case .failed = submission {
            setSubmission(.idle)
        }
    }

    /// 窗口过去之后收掉限流提示。由 `RateLimitNoticeView` 的 onExpire 调，但它**不是**
    /// 窗口的出口——能不能提交由 `rateLimitedUntil` 决定，视图不在场时窗口照样会到期，
    /// 这里只负责把已经过期的提示从界面上抹掉。窗口还没走完就误触发也不放行。
    func clearRateLimit() {
        guard !isRateLimited else { return }
        if case .failed(.remote(.rateLimited)) = submission {
            setSubmission(.idle)
        }
    }

    /// `submission` 的唯一写入口：顺带把限流窗口的截止时刻算好 / 清掉，
    /// 保证"界面显示的失败"与"挡不挡提交的窗口"永远说的是同一件事。
    private func setSubmission(_ next: Submission) {
        submission = next
        if case let .failed(.remote(.rateLimited(seconds))) = next {
            rateLimitedUntil = now().advanced(by: .seconds(seconds))
        } else {
            rateLimitedUntil = nil
        }
    }

    private func validate() -> [AuthFormField: String] {
        switch mode {
        case .signIn:
            AuthFormValidation.validateSignIn(email: email, password: password)
        case .signUp:
            AuthFormValidation.validateSignUp(name: name, email: email, password: password)
        }
    }

    /// 提交前归一化：输入的所有权在表单，去空白也该在这里做完再交出去
    /// （SessionController 里还有一道同样的处理，是给非表单调用方的兜底）。
    private func performRequest() async -> AuthSubmissionOutcome {
        let normalizedEmail = AuthFormValidation.normalizedEmail(email)

        switch mode {
        case .signIn:
            return await authenticator.performSignIn(email: normalizedEmail, password: password)
        case .signUp:
            let normalizedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
            return await authenticator.performSignUp(
                name: normalizedName,
                email: normalizedEmail,
                password: password
            )
        }
    }
}
