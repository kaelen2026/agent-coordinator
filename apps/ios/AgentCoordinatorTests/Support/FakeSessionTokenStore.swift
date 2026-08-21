@testable import AgentCoordinator
import Foundation

/// 内存版凭证存储。只替换 Keychain 这一个外部边界；可注入读写失败。
actor FakeSessionTokenStore: SessionTokenStore {
    struct Boom: Error, Equatable {}

    private var stored: SessionToken?
    private var failLoad = false
    private var failSave = false
    private var failClear = false
    private(set) var clearCount = 0
    private(set) var saveCount = 0

    init(stored: SessionToken? = nil) {
        self.stored = stored
    }

    func setFailures(load: Bool = false, save: Bool = false, clear: Bool = false) {
        failLoad = load
        failSave = save
        failClear = clear
    }

    func currentToken() -> SessionToken? {
        stored
    }

    func load() async throws -> SessionToken? {
        if failLoad {
            throw Boom()
        }
        return stored
    }

    func save(_ token: SessionToken) async throws {
        saveCount += 1
        if failSave {
            throw Boom()
        }
        stored = token
    }

    func clear() async throws {
        clearCount += 1
        if failClear {
            throw Boom()
        }
        stored = nil
    }
}
