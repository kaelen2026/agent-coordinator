import Foundation

/// 自有端点的错误 code。未知值降级为 `.unknown`，绝不让解码失败。
enum ApiErrorCode: Equatable, Sendable {
    case unauthenticated
    case rateLimited
    case payloadTooLarge
    case notFound
    case unknown(String)

    init(wireValue: String) {
        switch wireValue {
        case "UNAUTHENTICATED": self = .unauthenticated
        case "RATE_LIMITED": self = .rateLimited
        case "PAYLOAD_TOO_LARGE": self = .payloadTooLarge
        case "NOT_FOUND": self = .notFound
        default: self = .unknown(wireValue)
        }
    }

    var wireValue: String {
        switch self {
        case .unauthenticated: "UNAUTHENTICATED"
        case .rateLimited: "RATE_LIMITED"
        case .payloadTooLarge: "PAYLOAD_TOO_LARGE"
        case .notFound: "NOT_FOUND"
        case let .unknown(raw): raw
        }
    }
}

extension ApiErrorCode: Decodable {
    init(from decoder: any Decoder) throws {
        try self.init(wireValue: decoder.singleValueContainer().decode(String.self))
    }
}

/// `packages/contracts`: `apiErrorSchema` —— 本仓库自有端点（`/api/me` 等）的错误形状。
///
/// `details` 刻意不解码：契约里它是 `array(unknown)`，客户端不消费它，解码它只会给
/// 未来的服务端改动多一个失败点。
struct ApiErrorEnvelope: Decodable, Equatable, Sendable {
    struct Body: Decodable, Equatable, Sendable {
        let code: ApiErrorCode
        let message: String

        private enum CodingKeys: String, CodingKey {
            case code
            case message
        }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            code = try container.decode(ApiErrorCode.self, forKey: .code)
            message = container.lenient(String.self, forKey: .message, default: "")
        }
    }

    let error: Body
}
