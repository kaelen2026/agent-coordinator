@testable import AgentCoordinator
import Testing

@Suite("表单校验（只为体验，安全以后端为准）")
struct AuthFormValidationTests {
    @Test("密码长度与 api 的 better-auth 配置一致")
    func passwordBoundsMatchApi() {
        #expect(AuthFormValidation.passwordMinLength == 12)
        #expect(AuthFormValidation.passwordMaxLength == 128)
    }

    // MARK: - 登录

    @Test("登录不校验密码长度：规则收紧后老用户的旧密码不该被客户端拦下")
    func signInDoesNotCheckPasswordLength() {
        let errors = AuthFormValidation.validateSignIn(email: "a@b.co", password: "short")

        #expect(errors.isEmpty)
    }

    @Test("登录只拦空邮箱、空密码和明显不是邮箱的输入")
    func signInRejectsEmptyAndMalformed() {
        #expect(AuthFormValidation.validateSignIn(email: "", password: "x")[.email] != nil)
        #expect(AuthFormValidation.validateSignIn(email: "   ", password: "x")[.email] != nil)
        #expect(AuthFormValidation.validateSignIn(email: "not-an-email", password: "x")[.email] != nil)
        #expect(AuthFormValidation.validateSignIn(email: "a@b.co", password: "")[.password] != nil)
    }

    @Test("邮箱前后空白不算错：提交前 trim")
    func trimsEmailWhitespace() {
        #expect(AuthFormValidation.validateSignIn(email: "  a@b.co  ", password: "x").isEmpty)
        #expect(AuthFormValidation.normalizedEmail("  A@B.co  ") == "A@B.co")
    }

    // MARK: - 注册

    @Test("注册要求姓名、邮箱、12-128 位密码")
    func signUpAcceptsValidInput() {
        let errors = AuthFormValidation.validateSignUp(
            name: "Founder",
            email: "a@b.co",
            password: String(repeating: "a", count: 12)
        )

        #expect(errors.isEmpty)
    }

    @Test("注册密码短于 12 位被拦下（省限流额度）")
    func signUpRejectsShortPassword() {
        let errors = AuthFormValidation.validateSignUp(
            name: "Founder",
            email: "a@b.co",
            password: String(repeating: "a", count: 11)
        )

        #expect(errors[.password] != nil)
    }

    @Test("注册密码长于 128 位被拦下")
    func signUpRejectsLongPassword() {
        let ok = AuthFormValidation.validateSignUp(
            name: "F",
            email: "a@b.co",
            password: String(repeating: "a", count: 128)
        )
        let tooLong = AuthFormValidation.validateSignUp(
            name: "F",
            email: "a@b.co",
            password: String(repeating: "a", count: 129)
        )

        #expect(ok.isEmpty)
        #expect(tooLong[.password] != nil)
    }

    @Test("密码长度按字符数算，emoji 不被当成多位")
    func countsPasswordByCharacters() {
        let elevenEmoji = String(repeating: "👍", count: 11)
        let twelveEmoji = String(repeating: "👍", count: 12)

        #expect(AuthFormValidation.validateSignUp(name: "F", email: "a@b.co", password: elevenEmoji)[.password] != nil)
        #expect(AuthFormValidation.validateSignUp(name: "F", email: "a@b.co", password: twelveEmoji).isEmpty)
    }

    @Test("注册缺姓名被拦下")
    func signUpRequiresName() {
        let errors = AuthFormValidation.validateSignUp(
            name: "   ",
            email: "a@b.co",
            password: String(repeating: "a", count: 12)
        )

        #expect(errors[.name] != nil)
    }

    @Test("多个字段同时错时逐字段都有提示")
    func reportsEveryInvalidField() {
        let errors = AuthFormValidation.validateSignUp(name: "", email: "nope", password: "")

        #expect(errors[.name] != nil)
        #expect(errors[.email] != nil)
        #expect(errors[.password] != nil)
    }

    @Test("邮箱校验不比服务端严：常见合法写法都放过")
    func acceptsCommonValidEmails() {
        for email in ["a@b.co", "first.last+tag@sub.example.com", "x_y-z@example.io", "1@2.dev"] {
            #expect(AuthFormValidation.validateSignIn(email: email, password: "x").isEmpty, "\(email)")
        }
    }

    @Test("明显非法的邮箱写法被拦下")
    func rejectsMalformedEmails() {
        for email in ["a@", "@b.co", "a b@c.co", "a@b", "a@@b.co", "a@b..co", "a@b.c o"] {
            #expect(AuthFormValidation.validateSignIn(email: email, password: "x")[.email] != nil, "\(email)")
        }
    }
}
