@testable import AgentCoordinator
import Foundation
import Testing

@Suite("KeychainSessionTokenStore：真 Keychain 读写")
struct KeychainSessionTokenStoreTests {
    /// 每个测试用自己的 service，互不干扰（testing.md：测试之间相互独立、自建自清）。
    private func makeStore(_ label: String = UUID().uuidString) -> KeychainSessionTokenStore {
        KeychainSessionTokenStore(service: "dev.agentcoordinator.ios.tests.\(label)")
    }

    @Test("存进去再读出来逐字符相同（含 + / = 的签名）")
    func roundTripsTokenVerbatim() async throws {
        let store = makeStore()
        let token = try TestFixtures.token(ContractSamples.sessionTokenWithPlusAndSlashRaw)

        try await store.save(token)
        defer { Task { try? await store.clear() } }

        let loaded = try await store.load()
        #expect(loaded?.rawValue == ContractSamples.sessionTokenWithPlusAndSlashRaw)
        try await store.clear()
    }

    @Test("空的时候读出 nil，不抛错")
    func loadsNilWhenEmpty() async throws {
        let store = makeStore()

        #expect(try await store.load() == nil)
    }

    @Test("重复保存覆盖为最新值")
    func overwritesExistingToken() async throws {
        let store = makeStore()
        try await store.save(TestFixtures.token("first.aaaa="))
        try await store.save(TestFixtures.token("second.bbbb="))

        #expect(try await store.load()?.rawValue == "second.bbbb=")
        try await store.clear()
    }

    @Test("clear 之后读不到，且再 clear 一次不抛错（幂等）")
    func clearIsIdempotent() async throws {
        let store = makeStore()
        try await store.save(TestFixtures.token())

        try await store.clear()
        #expect(try await store.load() == nil)

        try await store.clear()
        #expect(try await store.load() == nil)
    }

    @Test("不同 service 之间互不可见")
    func storesAreIsolatedByService() async throws {
        let first = makeStore("a")
        let second = makeStore("b")
        try await first.save(TestFixtures.token())

        #expect(try await second.load() == nil)

        try await first.clear()
    }

    @Test("token 不会顺着字符串插值漏进日志")
    func tokenIsRedactedInDescriptions() throws {
        let token = try TestFixtures.token()

        #expect(!"\(token)".contains(ContractSamples.sessionTokenRaw))
        #expect(!String(describing: token).contains(ContractSamples.sessionTokenRaw))
        #expect(!"\(token)".isEmpty)
    }
}
