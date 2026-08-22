@testable import AgentCoordinator
import Foundation
import Testing

@MainActor
final class FakeAuthenticator: AuthenticationPerforming {
    var signInOutcomes: [AuthSubmissionOutcome] = []
    var signUpOutcomes: [AuthSubmissionOutcome] = []
    private(set) var signInCalls: [(email: String, password: String)] = []
    private(set) var signUpCalls: [(name: String, email: String, password: String)] = []
    var gate: AsyncGate?

    func performSignIn(email: String, password: String) async -> AuthSubmissionOutcome {
        signInCalls.append((email, password))
        if let gate {
            await gate.wait()
        }
        return signInOutcomes.isEmpty ? .failed(.remote(.unexpected(status: 0))) : signInOutcomes.removeFirst()
    }

    func performSignUp(name: String, email: String, password: String) async -> AuthSubmissionOutcome {
        signUpCalls.append((name, email, password))
        if let gate {
            await gate.wait()
        }
        return signUpOutcomes.isEmpty ? .failed(.remote(.unexpected(status: 0))) : signUpOutcomes.removeFirst()
    }
}

@Suite("AuthFormModel：客户端校验 + 提交状态")
@MainActor
struct AuthFormModelTests {
    private func signInForm(
        _ authenticator: FakeAuthenticator,
        clock: MutableClock? = nil
    ) -> AuthFormModel {
        guard let clock else {
            return AuthFormModel(mode: .signIn, authenticator: authenticator)
        }
        return AuthFormModel(mode: .signIn, authenticator: authenticator, now: clock.now)
    }

    private func signUpForm(_ authenticator: FakeAuthenticator) -> AuthFormModel {
        AuthFormModel(mode: .signUp, authenticator: authenticator)
    }

    @Test("校验不通过时一个请求都不发（省限流额度）")
    func invalidInputDoesNotHitNetwork() async {
        let authenticator = FakeAuthenticator()
        let form = signInForm(authenticator)
        form.email = "not-an-email"
        form.password = ""

        await form.submit()

        #expect(authenticator.signInCalls.isEmpty)
        #expect(form.fieldErrors[.email] != nil)
        #expect(form.fieldErrors[.password] != nil)
        #expect(form.submission == .idle)
    }

    @Test("注册模式校验 12 位下限，登录模式不校验长度")
    func passwordLengthRuleDependsOnMode() async {
        let authenticator = FakeAuthenticator()
        authenticator.signInOutcomes = [.authenticated]

        let signUp = signUpForm(authenticator)
        signUp.name = "Founder"
        signUp.email = "a@b.co"
        signUp.password = "short"
        await signUp.submit()
        #expect(signUp.fieldErrors[.password] != nil)
        #expect(authenticator.signUpCalls.isEmpty)

        let signIn = signInForm(authenticator)
        signIn.email = "a@b.co"
        signIn.password = "short"
        await signIn.submit()
        #expect(signIn.fieldErrors.isEmpty)
        #expect(authenticator.signInCalls.count == 1)
    }

    @Test("成功提交后清空密码，不把它留在内存里")
    func clearsPasswordAfterSuccess() async {
        let authenticator = FakeAuthenticator()
        authenticator.signInOutcomes = [.authenticated]
        let form = signInForm(authenticator)
        form.email = "a@b.co"
        form.password = "correct-horse-battery"

        await form.submit()

        #expect(form.submission == .idle)
        #expect(form.password.isEmpty)
    }

    @Test("失败时保留输入、给出可读文案")
    func surfacesFailureMessage() async {
        let authenticator = FakeAuthenticator()
        authenticator.signInOutcomes = [.failed(.remote(.invalidCredentials))]
        let form = signInForm(authenticator)
        form.email = "a@b.co"
        form.password = "wrong-password-x"

        await form.submit()

        #expect(form.submission == .failed(.remote(.invalidCredentials)))
        #expect(form.email == "a@b.co")
        #expect(form.failureMessage == AuthCopy.message(for: .invalidCredentials))
    }

    @Test("限流失败带出等待秒数，供界面倒计时")
    func surfacesRateLimitSeconds() async {
        let authenticator = FakeAuthenticator()
        authenticator.signInOutcomes = [.failed(.remote(.rateLimited(retryAfterSeconds: 10)))]
        let form = signInForm(authenticator)
        form.email = "a@b.co"
        form.password = "pw"

        await form.submit()

        #expect(form.rateLimitRetryAfterSeconds == 10)
    }

    @Test("非限流失败没有倒计时")
    func noCountdownForOtherFailures() async {
        let authenticator = FakeAuthenticator()
        authenticator.signInOutcomes = [.failed(.remote(.network))]
        let form = signInForm(authenticator)
        form.email = "a@b.co"
        form.password = "pw"

        await form.submit()

        #expect(form.rateLimitRetryAfterSeconds == nil)
    }

    @Test("Keychain 写不进去时给出专门的文案，而不是含糊的网络错误")
    func surfacesStorageUnavailable() async {
        let authenticator = FakeAuthenticator()
        authenticator.signInOutcomes = [.failed(.storageUnavailable)]
        let form = signInForm(authenticator)
        form.email = "a@b.co"
        form.password = "pw"

        await form.submit()

        #expect(form.submission == .failed(.storageUnavailable))
        #expect(form.failureMessage == AuthCopy.storageUnavailable)
    }

    @Test("提交中状态可见，且重复提交被忽略")
    func submittingStateBlocksDoubleSubmit() async {
        let gate = AsyncGate()
        let authenticator = FakeAuthenticator()
        authenticator.gate = gate
        authenticator.signInOutcomes = [.authenticated, .authenticated]
        let form = signInForm(authenticator)
        form.email = "a@b.co"
        form.password = "pw"

        let first = Task { await form.submit() }
        while authenticator.signInCalls.isEmpty {
            await Task.yield()
        }
        #expect(form.isSubmitting)

        await form.submit()
        await gate.open()
        await first.value

        #expect(authenticator.signInCalls.count == 1)
        #expect(form.isSubmitting == false)
    }

    @Test("改动输入会清掉上一次的失败提示")
    func editingClearsPreviousFailure() async {
        let authenticator = FakeAuthenticator()
        authenticator.signInOutcomes = [.failed(.remote(.invalidCredentials))]
        let form = signInForm(authenticator)
        form.email = "a@b.co"
        form.password = "wrong-password-x"
        await form.submit()
        #expect(form.submission == .failed(.remote(.invalidCredentials)))

        form.clearFailure()

        #expect(form.submission == .idle)
        #expect(form.failureMessage == nil)
    }

    @Test("提交前把 trim 过的邮箱和姓名发出去")
    func submitsNormalizedFields() async {
        let authenticator = FakeAuthenticator()
        authenticator.signUpOutcomes = [.authenticated]
        let form = signUpForm(authenticator)
        form.name = "  Founder  "
        form.email = "  a@b.co  "
        form.password = String(repeating: "a", count: 12)

        await form.submit()

        #expect(authenticator.signUpCalls.first?.email == "a@b.co")
        #expect(authenticator.signUpCalls.first?.name == "Founder")
    }

    @Test("重新提交前清掉上一轮的字段错误")
    func clearsStaleFieldErrors() async {
        let authenticator = FakeAuthenticator()
        authenticator.signInOutcomes = [.authenticated]
        let form = signInForm(authenticator)
        form.email = "bad"
        form.password = "pw"
        await form.submit()
        #expect(form.fieldErrors[.email] != nil)

        form.email = "a@b.co"
        await form.submit()

        #expect(form.fieldErrors.isEmpty)
        #expect(authenticator.signInCalls.count == 1)
    }

    // MARK: - 限流窗口

    //
    // 与 web 基线一致（apps/web/src/components/auth/sign-in-form.tsx:22
    // `blocked = state.submitting || state.failure?.kind === "rate-limited"`，
    // 且 web 表单非受控、编辑不清 failure）。窗口内再点只会继续吃 429，把窗口越拖越长。

    @Test("限流窗口内一个请求都不许再发")
    func rateLimitBlocksResubmission() async {
        let authenticator = FakeAuthenticator()
        authenticator.signInOutcomes = [
            .failed(.remote(.rateLimited(retryAfterSeconds: 10))),
            .authenticated,
        ]
        let form = signInForm(authenticator)
        form.email = "a@b.co"
        form.password = "pw"

        await form.submit()
        #expect(form.rateLimitRetryAfterSeconds == 10)
        #expect(form.isSubmitBlocked)

        await form.submit()

        #expect(authenticator.signInCalls.count == 1)
        #expect(form.rateLimitRetryAfterSeconds == 10)
    }

    @Test("改动输入不清掉限流倒计时：限流不是换个输入就没了的错误")
    func editingDoesNotClearRateLimit() async {
        let authenticator = FakeAuthenticator()
        authenticator.signInOutcomes = [
            .failed(.remote(.rateLimited(retryAfterSeconds: 10))),
            .authenticated,
        ]
        let form = signInForm(authenticator)
        form.email = "a@b.co"
        form.password = "pw"
        await form.submit()

        // 界面上任一 .onChange 都会走到这里
        form.password = "pw2"
        form.clearFailure()

        #expect(form.rateLimitRetryAfterSeconds == 10)
        #expect(form.isSubmitBlocked)

        await form.submit()
        #expect(authenticator.signInCalls.count == 1)
    }

    @Test("窗口走完后收掉提示，之后可以重新提交")
    func rateLimitClearsWhenWindowElapses() async {
        let clock = MutableClock()
        let authenticator = FakeAuthenticator()
        authenticator.signInOutcomes = [
            .failed(.remote(.rateLimited(retryAfterSeconds: 10))),
            .authenticated,
        ]
        let form = signInForm(authenticator, clock: clock)
        form.email = "a@b.co"
        form.password = "pw"
        await form.submit()

        clock.advance(by: 10)
        // RateLimitNoticeView 的 onExpire 走这条：它只负责把过期的提示从界面上抹掉，
        // 放不放行由截止时刻说了算
        form.clearRateLimit()

        #expect(form.submission == .idle)
        #expect(form.rateLimitRetryAfterSeconds == nil)
        #expect(form.isSubmitBlocked == false)

        await form.submit()
        #expect(authenticator.signInCalls.count == 2)
    }

    @Test("切后台再回来不会重新计时：窗口按截止时刻算，不随倒计时视图的生死重启")
    func rateLimitWindowIsMeasuredByDeadlineNotByCountdownView() async {
        // 倒计时挂在视图生命周期上（.task 在离屏 / 切后台时被取消），它是"重启"不是"续跑"。
        // 若窗口的唯一出口是倒计时走完的 onExpire，用户切个后台回来就要从头再数一遍，
        // 封锁时长会超过服务端给的窗口 —— 那是在惩罚用户。
        let clock = MutableClock()
        let authenticator = FakeAuthenticator()
        authenticator.signInOutcomes = [
            .failed(.remote(.rateLimited(retryAfterSeconds: 10))),
            .authenticated,
        ]
        let form = signInForm(authenticator, clock: clock)
        form.email = "a@b.co"
        form.password = "pw"

        await form.submit()
        #expect(form.rateLimitRetryAfterSeconds == 10)
        #expect(form.isSubmitBlocked)

        // 用户切到后台 30 秒：倒计时的 .task 被取消，onExpire 一次都没触发过
        clock.advance(by: 30)

        // 服务端的窗口早就过去了，回来就该能提交
        #expect(form.rateLimitRetryAfterSeconds == nil)
        #expect(form.isSubmitBlocked == false)

        await form.submit()
        #expect(authenticator.signInCalls.count == 2)
    }

    @Test("窗口没走完就不解除：倒计时视图误触发 onExpire 也不放行")
    func rateLimitWindowSurvivesPrematureExpiry() async {
        let clock = MutableClock()
        let authenticator = FakeAuthenticator()
        authenticator.signInOutcomes = [
            .failed(.remote(.rateLimited(retryAfterSeconds: 10))),
            .authenticated,
        ]
        let form = signInForm(authenticator, clock: clock)
        form.email = "a@b.co"
        form.password = "pw"
        await form.submit()

        clock.advance(by: 4)
        form.clearRateLimit()

        #expect(form.rateLimitRetryAfterSeconds == 6)
        #expect(form.isSubmitBlocked)

        await form.submit()
        #expect(authenticator.signInCalls.count == 1)
    }

    @Test("非限流的失败照旧随输入改动收掉，也不挡提交")
    func nonRateLimitFailureStillClearsOnEdit() async {
        let authenticator = FakeAuthenticator()
        authenticator.signInOutcomes = [.failed(.remote(.invalidCredentials)), .authenticated]
        let form = signInForm(authenticator)
        form.email = "a@b.co"
        form.password = "wrong-password-x"
        await form.submit()
        #expect(form.isSubmitBlocked == false)

        form.clearFailure()
        #expect(form.submission == .idle)

        await form.submit()
        #expect(authenticator.signInCalls.count == 2)
    }
}
