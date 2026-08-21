@testable import AgentCoordinator
import Testing

@Suite("SessionToken 原样透传")
struct SessionTokenTests {
    @Test("含 + / = 的签名逐字符保留")
    func preservesBase64SignatureVerbatim() throws {
        let token = try #require(SessionToken(rawValue: ContractSamples.sessionTokenWithPlusAndSlashRaw))

        #expect(token.rawValue == ContractSamples.sessionTokenWithPlusAndSlashRaw)
        #expect(token.rawValue.contains("+"))
        #expect(token.rawValue.contains("/"))
        #expect(token.rawValue.hasSuffix("="))
    }

    @Test("不做 URL 编码")
    func doesNotPercentEncode() throws {
        let token = try #require(SessionToken(rawValue: ContractSamples.sessionTokenWithPlusAndSlashRaw))

        #expect(!token.rawValue.contains("%2B"))
        #expect(!token.rawValue.contains("%2F"))
        #expect(!token.rawValue.contains("%3D"))
    }

    @Test("不按 . 截断：签名段必须还在")
    func doesNotTruncateAtSeparator() throws {
        let token = try #require(SessionToken(rawValue: ContractSamples.sessionTokenRaw))
        let signature = "JWMpR42ML44FnfjVvnyku8WrEf2R1Ku05vtuURed9AE="

        #expect(token.rawValue.hasSuffix(signature))
        #expect(token.rawValue.split(separator: ".").count == 2)
    }

    @Test("不 trim 内容，只拒绝空值")
    func rejectsOnlyEmptyValues() {
        #expect(SessionToken(rawValue: "") == nil)
        #expect(SessionToken(rawValue: "   ") == nil)
        #expect(SessionToken(rawValue: "\n\t") == nil)
    }

    @Test("Authorization 头值是 Bearer + 原样 token")
    func buildsBearerAuthorizationHeader() throws {
        let token = try #require(SessionToken(rawValue: ContractSamples.sessionTokenRaw))

        #expect(token.authorizationHeaderValue == "Bearer \(ContractSamples.sessionTokenRaw)")
    }

    @Test("token 形状未知时也接受：客户端不校验格式（服务端才是权威）")
    func acceptsUnknownShapes() throws {
        let opaque = try #require(SessionToken(rawValue: "opaque-future-format-without-dot"))

        #expect(opaque.rawValue == "opaque-future-format-without-dot")
    }
}
