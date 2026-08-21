import Foundation

/// `/api/auth/*` 的错误 code。契约的实测表覆盖到的分支具名，其余降级为 `.unknown`。
enum BetterAuthErrorCode: Equatable, Sendable {
    case validationError
    case passwordTooShort
    case passwordTooLong
    case badRequest
    case invalidEmailOrPassword
    case invalidOrigin
    case missingOrNullOrigin
    case userAlreadyExists
    case unknown(String)

    init(wireValue: String) {
        switch wireValue {
        case "VALIDATION_ERROR": self = .validationError
        case "PASSWORD_TOO_SHORT": self = .passwordTooShort
        case "PASSWORD_TOO_LONG": self = .passwordTooLong
        case "BAD_REQUEST": self = .badRequest
        case "INVALID_EMAIL_OR_PASSWORD": self = .invalidEmailOrPassword
        case "INVALID_ORIGIN": self = .invalidOrigin
        case "MISSING_OR_NULL_ORIGIN": self = .missingOrNullOrigin
        case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL": self = .userAlreadyExists
        default: self = .unknown(wireValue)
        }
    }

    var wireValue: String {
        switch self {
        case .validationError: "VALIDATION_ERROR"
        case .passwordTooShort: "PASSWORD_TOO_SHORT"
        case .passwordTooLong: "PASSWORD_TOO_LONG"
        case .badRequest: "BAD_REQUEST"
        case .invalidEmailOrPassword: "INVALID_EMAIL_OR_PASSWORD"
        case .invalidOrigin: "INVALID_ORIGIN"
        case .missingOrNullOrigin: "MISSING_OR_NULL_ORIGIN"
        case .userAlreadyExists: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"
        case let .unknown(raw): raw
        }
    }

    /// `.unknown` 对应的字段校验 code（若有）。归类时用来把 400 的四个 code 收到一起。
    var invalidInputCode: InvalidInputCode? {
        switch self {
        case .validationError: .validationError
        case .passwordTooShort: .passwordTooShort
        case .passwordTooLong: .passwordTooLong
        case .badRequest: .badRequest
        default: nil
        }
    }
}

extension BetterAuthErrorCode: Decodable {
    init(from decoder: any Decoder) throws {
        try self.init(wireValue: decoder.singleValueContainer().decode(String.self))
    }
}

/// `packages/contracts`: `betterAuthErrorSchema`。
/// `code` 是**可选**的——better-auth 的限流响应只有 message，客户端不能假设 code 一定存在。
struct BetterAuthErrorBody: Decodable, Equatable, Sendable {
    let message: String
    let code: BetterAuthErrorCode?

    private enum CodingKeys: String, CodingKey {
        case message
        case code
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        message = container.lenient(String.self, forKey: .message, default: "")
        code = container.lenientIfPresent(BetterAuthErrorCode.self, forKey: .code)
    }
}
