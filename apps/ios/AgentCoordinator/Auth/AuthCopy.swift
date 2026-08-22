/// 用户可见文案的唯一来源。
///
/// 两条硬性约束（与 web 的 `apps/web/src/lib/auth/messages.ts` 同源同措辞）：
/// 1. **不渲染服务端返回的 message** —— 既防内部措辞泄漏，也让两端文案统一；
/// 2. 凭证错不区分"账号不存在"与"密码错"，与 api 侧的刻意合并保持一致（security.md）。
enum AuthCopy {
    // MARK: - 字段校验

    static let nameRequired = "请输入姓名"
    static let emailRequired = "请输入邮箱"
    static let emailMalformed = "邮箱格式不正确"
    static let passwordRequired = "请输入密码"
    static let passwordTooShort = "密码至少 \(AuthFormValidation.passwordMinLength) 位"
    static let passwordTooLong = "密码最多 \(AuthFormValidation.passwordMaxLength) 位"

    // MARK: - 失败分支 → 用户可见文案

    static func message(for failure: AuthFailure) -> String {
        switch failure {
        case let .invalidInput(code):
            switch code {
            case .passwordTooShort:
                "密码至少 \(AuthFormValidation.passwordMinLength) 位，请换一个更长的密码。"
            case .passwordTooLong:
                "密码最多 \(AuthFormValidation.passwordMaxLength) 位，请换一个更短的密码。"
            case .validationError, .badRequest:
                "填写的信息不符合要求，请检查后重试。"
            }
        case .invalidCredentials:
            "邮箱或密码不正确。"
        case .emailTaken:
            "该邮箱已被注册，请换一个邮箱或直接登录。"
        case .unauthenticated:
            "登录状态已失效，请重新登录。"
        case let .rateLimited(retryAfterSeconds):
            rateLimitMessage(secondsRemaining: retryAfterSeconds)
        case .forbidden:
            // 一般是部署配置问题（Origin 不在 api 的白名单里），用户自己修不了。
            // 刻意不把 code 显示给用户：它是排查线索，不是用户能理解的信息。
            "请求被服务端拒绝，请联系管理员或稍后重试。"
        case .server:
            // 500 对客户端完全不可区分（api 的错误响应不含任何内部信息），
            // 因此不暴露状态码，一律按"稍后重试"处理。
            "服务暂时不可用，请稍后重试。"
        case .network:
            "网络连接失败，请检查网络后重试。"
        case .unexpected:
            "出现未知问题，请稍后重试。"
        }
    }

    /// 本地存不下凭证：和服务端错误不是一回事，给一条能指向真正原因的文案。
    static let storageUnavailable = "无法在本机保存登录状态，请检查系统设置后重试。"

    static func rateLimitMessage(secondsRemaining: Int) -> String {
        secondsRemaining > 0
            ? "操作过于频繁，请在 \(secondsRemaining) 秒后重试。"
            : "已经可以重试了，请重新提交。"
    }

    // MARK: - 五态文案

    static let checkingSession = "正在确认登录状态…"
    static let offlineTitle = "当前没有网络"
    static let offlineDescription = "连上网络后再试一次。"
    static let emptyProfileTitle = "资料还是空的"
    static let emptyProfileDescription = "服务端没有返回可展示的账号资料，稍后再看看。"
    static let retry = "重试"
    static let errorTitle = "没能读到登录状态"
    static let misconfiguredTitle = "App 配置有问题"

    /// 漏配时这一屏是必经首屏（`Release.xcconfig` 的 `API_BASE_URL` 刻意留空），所以它必须能
    /// 区分两种运维错误：**根本没传值**（发版流程漏了覆盖 xcconfig）与**传了个不合法的值**
    /// （CI 变量拼错、协议写错）。两者排查方向完全不同，文案一模一样等于把诊断信息扔了。
    ///
    /// 刻意不把那个地址本身印在界面上：它可能是内网域名，截图一发就外流了（security.md）。
    /// 真正的值在包的 Info.plist 里查得到，不需要显示给用户。
    static func misconfiguredDescription(for error: AppConfigurationError) -> String {
        switch error {
        case .missingBaseURL:
            "这个版本没有打进服务端地址，没法登录。请联系发布方重新出包。"
        case .malformedBaseURL:
            "打进这个版本的服务端地址不是合法的 http/https 地址，没法登录。请联系发布方检查发布配置。"
        }
    }

    static let signedInTitle = "我的账号"
    static let profileSection = "账号资料"
    static let nameField = "姓名"
    static let emailField = "邮箱"
    static let passwordField = "密码"
    static let emailVerifiedField = "邮箱已验证"
    static let yes = "是"
    static let no = "否"
    static let missingValuePlaceholder = "—"
    static let goToSignUp = "还没有账号？去注册"
    static let passwordRule = "密码 \(AuthFormValidation.passwordMinLength)–\(AuthFormValidation.passwordMaxLength) 位。"
    static let signInTitle = "登录"
    static let signUpTitle = "注册"
    static let signOut = "登出"
    static let signingOut = "登出中…"
}
