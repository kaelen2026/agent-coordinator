/// HTTP 头集合。头名大小写不敏感——契约里说明服务端实际下发的是全小写 `set-auth-token`，
/// 按 `Set-Auth-Token` 之类的写法去取必须同样取到。
struct HTTPHeaders: Equatable, Sendable {
    private let storage: [String: String]

    init(_ raw: [String: String]) {
        storage = Dictionary(
            raw.map { ($0.key.lowercased(), $0.value) },
            uniquingKeysWith: { _, latest in latest }
        )
    }

    func value(for name: String) -> String? {
        storage[name.lowercased()]
    }
}

/// 契约里出现的头名。与 `packages/contracts` 的 `SESSION_TOKEN_HEADER` 保持一致。
enum AuthHeaderName {
    /// `packages/contracts`: `SESSION_TOKEN_HEADER`
    static let sessionToken = "set-auth-token"
    static let authorization = "Authorization"
    static let origin = "Origin"
    static let contentType = "Content-Type"
    /// `/api/auth/*` 的限流重试头。
    static let betterAuthRetryAfter = "X-Retry-After"
    /// 自有端点的限流重试头。与上面**不是同一个名字**，契约里特别强调过。
    static let apiRetryAfter = "Retry-After"
}
