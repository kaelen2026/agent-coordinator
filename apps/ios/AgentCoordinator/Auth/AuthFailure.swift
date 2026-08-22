enum InvalidInputCode: String, Equatable, Sendable, CaseIterable {
    case validationError = "VALIDATION_ERROR"
    case passwordTooShort = "PASSWORD_TOO_SHORT"
    case passwordTooLong = "PASSWORD_TOO_LONG"
    case badRequest = "BAD_REQUEST"
}

enum AuthFailure: Equatable, Sendable {
    case invalidInput(InvalidInputCode)
    case invalidCredentials
    case emailTaken
    case unauthenticated
    case rateLimited(retryAfterSeconds: Int)
    case forbidden(code: String)
    case server(status: Int)
    case network
    case unexpected(status: Int)
}
