import OSLog

/// 认证相关的日志。
///
/// 硬性约束（`.claude/rules/swift.md` / `security.md`）：**只记分类，不记内容**。
/// 这里刻意只接受已经归好类的枚举，连字符串参数都不开放给调用方 —— token、
/// `Authorization` 头、邮箱、服务端 message 都没有任何路径进到日志里。
enum AuthLog {
    private static let logger = Logger(subsystem: "dev.agentcoordinator.ios", category: "auth")

    static func requestFailure(operation: StaticString, error: AuthRequestError) {
        logger
            .warning("auth request failed: op=\(operation, privacy: .public) kind=\(kind(of: error), privacy: .public)")
    }

    static func storageFailure(operation: StaticString) {
        logger.warning("credential store failed: op=\(operation, privacy: .public)")
    }

    /// 失败分类的稳定标识。刻意不含状态码之外的任何服务端内容。
    static func kind(of error: AuthRequestError) -> String {
        switch error {
        case let .transport(failure):
            switch failure {
            case .offline: "transport-offline"
            case .timedOut: "transport-timeout"
            case .cancelled: "transport-cancelled"
            case .other: "transport-other"
            }
        case let .failure(failure):
            switch failure {
            case .invalidInput: "invalid-input"
            case .invalidCredentials: "invalid-credentials"
            case .emailTaken: "email-taken"
            case .unauthenticated: "unauthenticated"
            case .rateLimited: "rate-limited"
            case .forbidden: "forbidden"
            case let .server(status): "server-\(status)"
            case .network: "network"
            case let .unexpected(status): "unexpected-\(status)"
            }
        }
    }
}
