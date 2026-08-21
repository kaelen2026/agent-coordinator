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
    private func signInForm(_ authenticator: FakeAuthenticator) -> AuthFormModel {
        AuthFormModel(mode: .signIn, authenticator: authenticator)
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
}
