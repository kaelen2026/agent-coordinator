import Foundation

struct HTTPRequest: Equatable, Sendable {
    enum Method: String, Equatable, Sendable {
        case get = "GET"
        case post = "POST"
    }

    let method: Method
    let url: URL
    let headers: [String: String]
    let body: Data?
}

struct HTTPResponse: Equatable, Sendable {
    let status: Int
    let headers: HTTPHeaders
    let body: Data
}

/// 网络传输的注入点。业务代码只依赖这个协议，测试用假实现替换（architecture.md：依赖注入）。
protocol HTTPTransport: Sendable {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse
}

/// 拿不到响应的失败（断网、超时、取消）。与"拿到了响应但是错误状态"完全分开：
/// 前者可重试且可能是离线，后者要按契约的 code 归类。
enum TransportFailure: Error, Equatable, Sendable {
    case offline
    case timedOut
    case cancelled
    case other

    static func classify(_ error: any Error) -> TransportFailure {
        // 传输层已经分好类的直接透传，别把它降级成 .other
        if let already = error as? TransportFailure {
            return already
        }
        if error is CancellationError {
            return .cancelled
        }
        guard let urlError = error as? URLError else { return .other }

        switch urlError.code {
        // 只把"设备确实没网"归为离线。`cannotConnectToHost` / `dnsLookupFailed` 更常见的
        // 原因是服务端没起或域名解析异常，把它们说成"当前没有网络"会误导用户去查 WiFi。
        case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed,
             .internationalRoamingOff:
            return .offline
        case .timedOut:
            return .timedOut
        case .cancelled:
            return .cancelled
        default:
            return .other
        }
    }
}
