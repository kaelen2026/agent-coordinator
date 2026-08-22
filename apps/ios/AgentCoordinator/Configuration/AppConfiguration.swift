import Foundation

/// 运行时配置。api 地址来自 xcconfig → Info.plist，业务代码只读这里，
/// 不在任何地方硬编码 `http://localhost:3001`（`.claude/rules/architecture.md`）。
struct AppConfiguration: Equatable, Sendable {
    /// Info.plist 里的键，值由 `Configuration/*.xcconfig` 的 `API_BASE_URL` 展开而来。
    static let baseURLInfoKey = "APIBaseURL"

    let apiBaseURL: URL

    /// 固定发给 api 的 `Origin`：就是 api 自己的源。
    ///
    /// 契约第 4 节：better-auth 恒把 `baseURL` 的源放进 trustedOrigins，所以这个值在
    /// "强制校验 origin"和"不校验"两条分支下都通得过，比"什么都不发"更抗库升级；
    /// 自己编一个源（含自定义 scheme）会吃 403 `INVALID_ORIGIN`。
    let originHeaderValue: String

    init(apiBaseURL: URL) throws {
        guard let components = URLComponents(url: apiBaseURL, resolvingAgainstBaseURL: false),
              let rawScheme = components.scheme?.lowercased(),
              rawScheme == "http" || rawScheme == "https",
              let rawHost = components.host?.lowercased(), !rawHost.isEmpty
        else { throw AppConfigurationError.malformedBaseURL(apiBaseURL.absoluteString) }

        // 只保留 scheme/host/port/path：query 与 fragment 不属于 base URL。
        var normalized = URLComponents()
        normalized.scheme = rawScheme
        normalized.host = rawHost
        normalized.port = components.port
        normalized.path = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path

        guard let base = normalized.url else {
            throw AppConfigurationError.malformedBaseURL(apiBaseURL.absoluteString)
        }
        self.apiBaseURL = base

        // RFC 6454 的 origin 序列化：默认端口不出现在 origin 里。
        var origin = "\(rawScheme)://\(rawHost)"
        if let port = components.port, port != Self.defaultPort(forScheme: rawScheme) {
            origin += ":\(port)"
        }
        originHeaderValue = origin
    }

    static func load(from bundle: Bundle) throws -> AppConfiguration {
        guard let raw = bundle.object(forInfoDictionaryKey: baseURLInfoKey) as? String,
              case let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty
        else { throw AppConfigurationError.missingBaseURL }

        guard let url = URL(string: trimmed) else { throw AppConfigurationError.malformedBaseURL(trimmed) }

        return try AppConfiguration(apiBaseURL: url)
    }

    /// 拼接端点。base URL 带路径前缀（网关部署）时前缀会保留。
    func url(path: String) -> URL {
        apiBaseURL.appending(path: path.hasPrefix("/") ? String(path.dropFirst()) : path)
    }

    private static func defaultPort(forScheme scheme: String) -> Int? {
        switch scheme {
        case "http": 80
        case "https": 443
        default: nil
        }
    }
}

enum AppConfigurationError: Error, Equatable {
    /// Info.plist 里没有 api 地址：宁可 fail fast 也不兜底到某个猜测的地址。
    case missingBaseURL
    case malformedBaseURL(String)
}
