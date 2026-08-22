import Foundation

/// 后端两套错误形状 → 用户可见反馈的唯一归类点（与 web 的 `apps/web/src/lib/auth/failure.ts`
/// 语义对齐，两端对同一个响应给出同一个分类）。
///
/// 契约里 `/api/auth/*` 用 `betterAuthErrorSchema`、自有端点用 `apiErrorSchema`，两者不通用；
/// 再加上两种 429 的重试头名字不同。这些差异只在本文件消化，ViewModel 与 View 只认 `AuthFailure`。
enum AuthFailureClassifier {
    /// 读不到重试头时自己的退避值。契约明确说明服务端那些秒数是观测值、不是常量。
    static let fallbackRetryAfterSeconds = 60

    /// 倒计时上限：服务端给出荒谬值时不把用户锁在一个几小时的倒计时里。
    static let maxRetryAfterSeconds = 3600

    private static let decoder = JSONDecoder()

    /// 重试头是运行时边界数据：只接受正整数秒，其余一律退避到自己的默认值。
    static func retryAfterSeconds(from headers: HTTPHeaders, headerName: String) -> Int {
        guard let raw = headers.value(for: headerName) else { return fallbackRetryAfterSeconds }

        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        // 只认 ASCII 数字：全角数字、正负号、小数点、`1e3`、`60s` 全部当非法值。
        guard !trimmed.isEmpty, trimmed.allSatisfy({ $0.isASCII && $0.isNumber }) else {
            return fallbackRetryAfterSeconds
        }

        // 纯数字但撑爆 Int，只可能是荒谬的大值 —— 直接落到上限，不退回默认值。
        guard let seconds = Int(trimmed) else { return maxRetryAfterSeconds }
        guard seconds > 0 else { return fallbackRetryAfterSeconds }

        return min(seconds, maxRetryAfterSeconds)
    }

    /// `/api/auth/*`（better-auth 自带路由）的错误响应归类。
    static func classifyBetterAuth(status: Int, body: Data, headers: HTTPHeaders) -> AuthFailure {
        if status == 429 {
            return .rateLimited(
                retryAfterSeconds: retryAfterSeconds(from: headers, headerName: AuthHeaderName.betterAuthRetryAfter)
            )
        }
        if status >= 500 {
            return .server(status: status)
        }

        // 运行时边界：body 先按契约解出来才允许进类型世界，解不出来就降级。
        guard let parsed = try? decoder.decode(BetterAuthErrorBody.self, from: body),
              let code = parsed.code
        else { return .unexpected(status: status) }

        if status == 403 {
            return .forbidden(code: code.wireValue)
        }
        if status == 400, let invalidInput = code.invalidInputCode {
            return .invalidInput(invalidInput)
        }
        // 刻意不区分"账号不存在"与"密码错"：api 侧是故意合并的（security.md），UI 跟着合并。
        if status == 401, code == .invalidEmailOrPassword {
            return .invalidCredentials
        }
        if status == 422, code == .userAlreadyExists {
            return .emailTaken
        }

        return .unexpected(status: status)
    }

    /// 本仓库自有端点（`/api/me` 等）的错误响应归类。
    static func classifyApi(status: Int, body: Data, headers: HTTPHeaders) -> AuthFailure {
        if status == 429 {
            return .rateLimited(
                retryAfterSeconds: retryAfterSeconds(from: headers, headerName: AuthHeaderName.apiRetryAfter)
            )
        }
        if status >= 500 {
            return .server(status: status)
        }

        guard let parsed = try? decoder.decode(ApiErrorEnvelope.self, from: body) else {
            return .unexpected(status: status)
        }

        let code = parsed.error.code
        if status == 403 {
            return .forbidden(code: code.wireValue)
        }
        // 契约：401 的四种原因（无效/过期/伪造/根本没带）响应逐字节相同，客户端不试图区分。
        if status == 401, code == .unauthenticated {
            return .unauthenticated
        }

        return .unexpected(status: status)
    }
}
