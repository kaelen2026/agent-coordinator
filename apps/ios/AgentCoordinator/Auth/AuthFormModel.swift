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

    private let authenticator: any AuthenticationPerforming

    init(mode: Mode, authenticator: any AuthenticationPerforming) {
        self.mode = mode
        self.authenticator = authenticator
    }

    var isSubmitting: Bool {
        submission == .submitting
    }

    var failureMessage: String? {
        guard case let .failed(failure) = submission else { return nil }
        switch failure {
        case let .remote(remote): return AuthCopy.message(for: remote)
        case .storageUnavailable: return AuthCopy.storageUnavailable
        }
    }

    /// 限流时的等待秒数，供界面倒计时。秒数来自响应头，不是写死的常量。
    var rateLimitRetryAfterSeconds: Int? {
        guard case let .failed(.remote(.rateLimited(seconds))) = submission else { return nil }
        return seconds
    }

    func submit() async {
        // 进行中重复点击直接忽略：连点两次注册会白吃限流额度，也可能建出两次请求。
        guard !isSubmitting else { return }

        let errors = validate()
        fieldErrors = errors
        guard errors.isEmpty else {
            submission = .idle
            return
        }

        submission = .submitting

        switch await performRequest() {
        case .authenticated:
            // 成功后不把密码留在内存里
            password = ""
            submission = .idle
        case let .failed(failure):
            submission = .failed(failure)
        }
    }

    /// 用户改动输入时把上一次的失败提示收掉，避免旧错误挂在新输入上。
    func clearFailure() {
        if case .failed = submission {
            submission = .idle
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
