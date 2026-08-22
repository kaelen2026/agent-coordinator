import Foundation

/// URLSession 实现。
///
/// 会话配置刻意用 `ephemeral`：cache / cookie / credential 一律只在内存里，任何凭证相关
/// 的数据都不落盘（`.claude/rules/swift.md` 敏感信息条款）。cookie 还额外整体关掉——
/// 契约第 4 节：better-auth 的 origin/CSRF 校验一旦看到 `Cookie` 头就会强制生效，
/// 原生客户端走 bearer，根本不该带 cookie。
struct URLSessionTransport: HTTPTransport {
    /// security.md：没有超时的网络调用视为 bug。
    static let requestTimeout: TimeInterval = 15
    static let resourceTimeout: TimeInterval = 30

    private let session: URLSession

    init(session: URLSession) {
        self.session = session
    }

    static func makeSession() -> URLSession {
        URLSession(configuration: makeConfiguration())
    }

    static func makeConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = requestTimeout
        configuration.timeoutIntervalForResource = resourceTimeout
        return configuration
    }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        var urlRequest = URLRequest(url: request.url)
        urlRequest.httpMethod = request.method.rawValue
        urlRequest.httpBody = request.body
        for (name, value) in request.headers {
            urlRequest.setValue(value, forHTTPHeaderField: name)
        }

        do {
            let (data, response) = try await session.data(for: urlRequest)
            guard let http = response as? HTTPURLResponse else { throw TransportFailure.other }

            let headers = HTTPHeaders(
                Dictionary(
                    http.allHeaderFields.compactMap { key, value -> (String, String)? in
                        guard let name = key as? String, let text = value as? String else { return nil }
                        return (name, text)
                    },
                    uniquingKeysWith: { _, latest in latest }
                )
            )

            return HTTPResponse(status: http.statusCode, headers: headers, body: data)
        } catch let failure as TransportFailure {
            throw failure
        } catch {
            throw TransportFailure.classify(error)
        }
    }
}
