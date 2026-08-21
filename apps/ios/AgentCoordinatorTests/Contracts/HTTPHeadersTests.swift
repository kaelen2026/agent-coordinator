@testable import AgentCoordinator
import Testing

@Suite("HTTPHeaders 大小写不敏感")
struct HTTPHeadersTests {
    @Test("服务端下发全小写 set-auth-token，按契约常量名也能取到")
    func findsLowercaseSessionTokenHeader() {
        let headers = HTTPHeaders(["set-auth-token": ContractSamples.sessionTokenRaw])

        #expect(headers.value(for: AuthHeaderName.sessionToken) == ContractSamples.sessionTokenRaw)
        #expect(headers.value(for: "Set-Auth-Token") == ContractSamples.sessionTokenRaw)
        #expect(headers.value(for: "SET-AUTH-TOKEN") == ContractSamples.sessionTokenRaw)
    }

    @Test("头名常量与契约一致")
    func headerNamesMatchContract() {
        // packages/contracts: SESSION_TOKEN_HEADER = "set-auth-token"
        #expect(AuthHeaderName.sessionToken == "set-auth-token")
        #expect(AuthHeaderName.authorization == "Authorization")
        #expect(AuthHeaderName.origin == "Origin")
        // 两个重试头名字不同，这是契约里特别强调的一条
        #expect(AuthHeaderName.betterAuthRetryAfter == "X-Retry-After")
        #expect(AuthHeaderName.apiRetryAfter == "Retry-After")
        #expect(AuthHeaderName.betterAuthRetryAfter != AuthHeaderName.apiRetryAfter)
    }

    @Test("缺失的头返回 nil")
    func missingHeaderIsNil() {
        #expect(HTTPHeaders([:]).value(for: AuthHeaderName.sessionToken) == nil)
    }
}
