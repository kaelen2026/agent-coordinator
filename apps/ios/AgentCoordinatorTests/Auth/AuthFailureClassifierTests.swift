@testable import AgentCoordinator
import Foundation
import Testing

@Suite("失败归类：契约实测表逐行钉住")
struct AuthFailureClassifierTests {
    private func betterAuth(_ status: Int, _ code: String, headers: [String: String] = [:]) -> AuthFailure {
        AuthFailureClassifier.classifyBetterAuth(
            status: status,
            body: ContractSamples.betterAuthError(code: code),
            headers: HTTPHeaders(headers)
        )
    }

    private func api(_ status: Int, _ code: String, headers: [String: String] = [:]) -> AuthFailure {
        AuthFailureClassifier.classifyApi(
            status: status,
            body: ContractSamples.apiError(code: code),
            headers: HTTPHeaders(headers)
        )
    }

    // MARK: - /api/auth/* （betterAuthErrorSchema）

    @Test("400 的四个 code 归为字段校验错")
    func classifiesInvalidInput() {
        #expect(betterAuth(400, "VALIDATION_ERROR") == .invalidInput(.validationError))
        #expect(betterAuth(400, "PASSWORD_TOO_SHORT") == .invalidInput(.passwordTooShort))
        #expect(betterAuth(400, "PASSWORD_TOO_LONG") == .invalidInput(.passwordTooLong))
        #expect(betterAuth(400, "BAD_REQUEST") == .invalidInput(.badRequest))
    }

    @Test("范围外的 400 code 不冒充已知分支")
    func unknown400CodeIsUnexpected() {
        #expect(betterAuth(400, "SOMETHING_ELSE") == .unexpected(status: 400))
    }

    @Test("401 INVALID_EMAIL_OR_PASSWORD 归为凭证错（不区分账号不存在与密码错）")
    func classifiesInvalidCredentials() {
        #expect(betterAuth(401, "INVALID_EMAIL_OR_PASSWORD") == .invalidCredentials)
    }

    @Test("403 携带 code 原文，便于排查部署配置")
    func classifiesForbidden() {
        #expect(betterAuth(403, "INVALID_ORIGIN") == .forbidden(code: "INVALID_ORIGIN"))
        #expect(betterAuth(403, "MISSING_OR_NULL_ORIGIN") == .forbidden(code: "MISSING_OR_NULL_ORIGIN"))
    }

    @Test("422 重复邮箱")
    func classifiesEmailTaken() {
        #expect(betterAuth(422, "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") == .emailTaken)
    }

    @Test("429 读 X-Retry-After（不是 Retry-After）")
    func readsBetterAuthRetryHeader() {
        let failure = AuthFailureClassifier.classifyBetterAuth(
            status: 429,
            body: ContractSamples.betterAuthErrorWithoutCode,
            headers: HTTPHeaders(["X-Retry-After": "10"])
        )

        #expect(failure == .rateLimited(retryAfterSeconds: 10))
    }

    @Test("429 只认自己那个头名：自有端点的 Retry-After 不生效")
    func ignoresWrongRetryHeaderName() {
        let failure = AuthFailureClassifier.classifyBetterAuth(
            status: 429,
            body: ContractSamples.betterAuthErrorWithoutCode,
            headers: HTTPHeaders(["Retry-After": "7"])
        )

        #expect(failure == .rateLimited(retryAfterSeconds: AuthFailureClassifier.fallbackRetryAfterSeconds))
    }

    @Test("5xx 归为服务端错误")
    func classifiesServerError() {
        #expect(betterAuth(500, "WHATEVER") == .server(status: 500))
        #expect(betterAuth(503, "WHATEVER") == .server(status: 503))
    }

    @Test("body 不是 JSON 时降级为 unexpected，不抛错")
    func nonJSONBodyIsUnexpected() {
        let failure = AuthFailureClassifier.classifyBetterAuth(
            status: 418,
            body: ContractSamples.notJSON,
            headers: HTTPHeaders([:])
        )

        #expect(failure == .unexpected(status: 418))
    }

    @Test("非 429/5xx 且 code 缺失时归为 unexpected")
    func missingCodeIsUnexpected() {
        let failure = AuthFailureClassifier.classifyBetterAuth(
            status: 400,
            body: ContractSamples.betterAuthErrorWithoutCode,
            headers: HTTPHeaders([:])
        )

        #expect(failure == .unexpected(status: 400))
    }

    // MARK: - 自有端点（apiErrorSchema）

    @Test("401 UNAUTHENTICATED")
    func classifiesUnauthenticated() {
        #expect(api(401, "UNAUTHENTICATED") == .unauthenticated)
    }

    @Test("429 读 Retry-After（不是 X-Retry-After）")
    func readsApiRetryHeader() {
        #expect(api(429, "RATE_LIMITED", headers: ["Retry-After": "60"]) == .rateLimited(retryAfterSeconds: 60))
        #expect(
            api(429, "RATE_LIMITED", headers: ["X-Retry-After": "9"])
                == .rateLimited(retryAfterSeconds: AuthFailureClassifier.fallbackRetryAfterSeconds)
        )
    }

    @Test("自有端点 403 也带上 code")
    func classifiesApiForbidden() {
        #expect(api(403, "SOME_CODE") == .forbidden(code: "SOME_CODE"))
    }

    @Test("自有端点 5xx 与非 JSON 同样降级")
    func classifiesApiServerAndGarbage() {
        #expect(api(500, "X") == .server(status: 500))

        let garbage = AuthFailureClassifier.classifyApi(
            status: 404,
            body: ContractSamples.notJSON,
            headers: HTTPHeaders([:])
        )
        #expect(garbage == .unexpected(status: 404))
    }

    @Test("自有端点未覆盖的 code 归为 unexpected")
    func classifiesApiUnexpected() {
        #expect(api(413, "PAYLOAD_TOO_LARGE") == .unexpected(status: 413))
    }

    // MARK: - 重试头解析的三条边界

    @Test("重试头缺失退避到默认 60 秒")
    func fallsBackWhenHeaderMissing() {
        #expect(AuthFailureClassifier.fallbackRetryAfterSeconds == 60)
        #expect(
            AuthFailureClassifier.retryAfterSeconds(from: HTTPHeaders([:]), headerName: "Retry-After")
                == 60
        )
    }

    @Test("非法值（非数字/负数/零/小数/空白）一律退避到默认值")
    func fallsBackOnIllegalValues() {
        for raw in ["", "  ", "abc", "-1", "0", "1.5", "60s", "1e3", "+30", "０"] {
            let seconds = AuthFailureClassifier.retryAfterSeconds(
                from: HTTPHeaders(["Retry-After": raw]),
                headerName: "Retry-After"
            )
            #expect(seconds == AuthFailureClassifier.fallbackRetryAfterSeconds, "raw=\(raw)")
        }
    }

    @Test("荒谬的大值截到上限 3600 秒")
    func clampsToUpperBound() {
        #expect(AuthFailureClassifier.maxRetryAfterSeconds == 3600)

        for raw in ["3601", "86400", "999999999999999999999"] {
            let seconds = AuthFailureClassifier.retryAfterSeconds(
                from: HTTPHeaders(["Retry-After": raw]),
                headerName: "Retry-After"
            )
            #expect(seconds == 3600, "raw=\(raw)")
        }
    }

    @Test("正整数原样采用，带首尾空白也接受")
    func acceptsPositiveIntegers() {
        #expect(
            AuthFailureClassifier.retryAfterSeconds(from: HTTPHeaders(["Retry-After": "10"]), headerName: "Retry-After")
                == 10
        )
        #expect(
            AuthFailureClassifier.retryAfterSeconds(
                from: HTTPHeaders(["Retry-After": " 45 "]),
                headerName: "Retry-After"
            ) == 45
        )
        #expect(
            AuthFailureClassifier.retryAfterSeconds(
                from: HTTPHeaders(["Retry-After": "3600"]),
                headerName: "Retry-After"
            ) == 3600
        )
    }
}
