@testable import AgentCoordinator
import Foundation
import Testing

@Suite("契约解码向前兼容")
struct ContractDecodingTests {
    private let decoder = JSONDecoder()

    // MARK: - /api/me

    @Test("契约样本正常解码")
    func decodesContractSample() throws {
        let response = try decoder.decode(MeResponse.self, from: ContractSamples.meResponse)

        #expect(response.user.id == "usr_01HZX")
        #expect(response.user.email == "founder@example.com")
        #expect(response.user.name == "Founder")
        #expect(response.user.emailVerified == false)
        #expect(response.user.imageURL == nil)
        #expect(response.user.createdAt == "2026-08-21T10:11:12.000Z")
    }

    @Test("服务端新增未知字段：解码照旧成功")
    func toleratesUnknownFields() throws {
        let response = try decoder.decode(MeResponse.self, from: ContractSamples.meResponseWithUnknownFields)

        #expect(response.user.id == "usr_01HZX")
        #expect(response.user.emailVerified == true)
        #expect(response.user.imageURL == URL(string: "https://cdn.example.com/a.png"))
    }

    @Test("image 给了不可用的值：降级为 nil，不让整条解码失败")
    func degradesUnusableImage() throws {
        let response = try decoder.decode(MeResponse.self, from: ContractSamples.meResponseWithUnusableImage)

        #expect(response.user.imageURL == nil)
        #expect(response.user.email == "founder@example.com")
    }

    @Test("可选字段缺失时按默认值降级，不抛错")
    func toleratesMissingOptionalFields() throws {
        let minimal = Data(#"{ "user": { "id": "u1", "email": "a@b.co", "createdAt": "x" } }"#.utf8)

        let response = try decoder.decode(MeResponse.self, from: minimal)

        #expect(response.user.name.isEmpty)
        #expect(response.user.emailVerified == false)
        #expect(response.user.imageURL == nil)
    }

    // MARK: - 错误体

    @Test("自有端点错误体解码，未知字段与 details 都不影响")
    func decodesApiErrorWithUnknownFields() throws {
        let envelope = try decoder.decode(ApiErrorEnvelope.self, from: ContractSamples.apiErrorWithUnknownFields)

        #expect(envelope.error.code == .unauthenticated)
    }

    @Test("未知的 code 降级为 unknown，不解码失败")
    func decodesUnknownApiErrorCode() throws {
        let envelope = try decoder.decode(
            ApiErrorEnvelope.self,
            from: ContractSamples.apiError(code: "SOME_FUTURE_CODE")
        )

        #expect(envelope.error.code == .unknown("SOME_FUTURE_CODE"))
    }

    @Test("已知的自有端点 code 全部映射到具名分支")
    func mapsKnownApiErrorCodes() throws {
        let cases: [(String, ApiErrorCode)] = [
            ("UNAUTHENTICATED", .unauthenticated),
            ("RATE_LIMITED", .rateLimited),
            ("PAYLOAD_TOO_LARGE", .payloadTooLarge),
            ("NOT_FOUND", .notFound),
        ]

        for (raw, expected) in cases {
            let envelope = try decoder.decode(ApiErrorEnvelope.self, from: ContractSamples.apiError(code: raw))
            #expect(envelope.error.code == expected, "\(raw)")
        }
    }

    @Test("better-auth 错误体：已知 code 全部映射")
    func mapsKnownBetterAuthCodes() throws {
        let cases: [(String, BetterAuthErrorCode)] = [
            ("VALIDATION_ERROR", .validationError),
            ("PASSWORD_TOO_SHORT", .passwordTooShort),
            ("PASSWORD_TOO_LONG", .passwordTooLong),
            ("BAD_REQUEST", .badRequest),
            ("INVALID_EMAIL_OR_PASSWORD", .invalidEmailOrPassword),
            ("INVALID_ORIGIN", .invalidOrigin),
            ("MISSING_OR_NULL_ORIGIN", .missingOrNullOrigin),
            ("USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL", .userAlreadyExists),
        ]

        for (raw, expected) in cases {
            let body = try decoder.decode(BetterAuthErrorBody.self, from: ContractSamples.betterAuthError(code: raw))
            #expect(body.code == expected, "\(raw)")
        }
    }

    @Test("better-auth 未知 code 降级为 unknown")
    func decodesUnknownBetterAuthCode() throws {
        let body = try decoder.decode(
            BetterAuthErrorBody.self,
            from: ContractSamples.betterAuthError(code: "FUTURE_BRANCH")
        )

        #expect(body.code == .unknown("FUTURE_BRANCH"))
    }

    @Test("better-auth 限流响应没有 code：code 为 nil 而非解码失败")
    func decodesBetterAuthErrorWithoutCode() throws {
        let body = try decoder.decode(BetterAuthErrorBody.self, from: ContractSamples.betterAuthErrorWithoutCode)

        #expect(body.code == nil)
        #expect(!body.message.isEmpty)
    }
}
