import Foundation

enum AuthFormField: Hashable, Sendable {
    case name
    case email
    case password
}

/// 表单校验。**只为体验服务**，安全以后端为准。
///
/// 之所以值得在客户端也拦一道：api 对 sign-in / sign-up 的限流是每 IP 每 10 秒 3 次，
/// 一次"密码写太短"的往返就白白吃掉三分之一额度，用户很容易把自己锁住。
enum AuthFormValidation {
    /// 与 apps/api 的 better-auth `emailAndPassword` 配置保持一致
    /// （`minPasswordLength: 12` / `maxPasswordLength: 128`）。
    ///
    /// 单位是 **UTF-16 码元**，不是字素簇：服务端判的是 JS 的 `String.length`。
    /// 用 Swift 的 `String.count`（字素）会两头都判错——11 个 emoji（22 码元）服务端放行
    /// 却被客户端拦下，128 个 emoji（256 码元）客户端放行却吃 `PASSWORD_TOO_LONG`。
    /// 客户端不可热修，口径必须跟着服务端走。
    static let passwordMinLength = 12
    static let passwordMaxLength = 128

    /// 提交前对邮箱做的归一化：只去首尾空白，**不改大小写**（本地部分大小写敏感由服务端裁定）。
    static func normalizedEmail(_ email: String) -> String {
        email.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func validateSignIn(email: String, password: String) -> [AuthFormField: String] {
        var errors: [AuthFormField: String] = [:]
        if let emailError = emailError(email) {
            errors[.email] = emailError
        }
        // 登录不校验密码长度：密码规则以后收紧时，老用户的合法旧密码不该被客户端拦下来，
        // 该由后端判定；客户端只保证不发空请求。
        if password.isEmpty {
            errors[.password] = AuthCopy.passwordRequired
        }
        return errors
    }

    static func validateSignUp(name: String, email: String, password: String) -> [AuthFormField: String] {
        var errors: [AuthFormField: String] = [:]
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            errors[.name] = AuthCopy.nameRequired
        }
        if let emailError = emailError(email) {
            errors[.email] = emailError
        }

        // 用 utf16.count 而不是 count：见 passwordMinLength 的说明。
        let passwordLength = password.utf16.count
        if password.isEmpty {
            errors[.password] = AuthCopy.passwordRequired
        } else if passwordLength < passwordMinLength {
            errors[.password] = AuthCopy.passwordTooShort
        } else if passwordLength > passwordMaxLength {
            errors[.password] = AuthCopy.passwordTooLong
        }

        return errors
    }

    /// 刻意保守：只拦明显不可能是邮箱的输入。比服务端更严会把合法用户挡在门外，
    /// 而漏过去的非法值后端会拒（客户端校验是体验优化，不是校验权威）。
    private static func emailError(_ email: String) -> String? {
        let trimmed = normalizedEmail(email)
        if trimmed.isEmpty {
            return AuthCopy.emailRequired
        }

        guard trimmed.unicodeScalars.allSatisfy({ !CharacterSet.whitespacesAndNewlines.contains($0) }) else {
            return AuthCopy.emailMalformed
        }

        let parts = trimmed.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, let local = parts.first, let domain = parts.last,
              !local.isEmpty, !domain.isEmpty
        else { return AuthCopy.emailMalformed }

        let labels = domain.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 2, labels.allSatisfy({ !$0.isEmpty }),
              let tld = labels.last, tld.count >= 2
        else { return AuthCopy.emailMalformed }

        return nil
    }
}
