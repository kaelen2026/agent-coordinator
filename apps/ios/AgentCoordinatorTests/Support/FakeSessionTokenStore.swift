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
    private(set) var loadCount = 0

    /// 让某一次读写在**动过底层存储之后**挂住，用来制造"Keychain 已经变了、调用方还没从
    /// await 里恢复"的窗口 —— 跨操作的竞态就藏在这个窗口里，靠 sleep 撞不稳定。
    private var saveGate: AsyncGate?
    private var gatedSaveCall: Int?
    private var loadGate: AsyncGate?
    private var clearGate: AsyncGate?

    init(stored: SessionToken? = nil) {
        self.stored = stored
    }

    func setFailures(load: Bool = false, save: Bool = false, clear: Bool = false) {
        failLoad = load
        failSave = save
        failClear = clear
    }

    /// 第 `call` 次 save（从 1 开始计）在写入之后挂住。
    func setSaveGate(_ gate: AsyncGate, onCall call: Int) {
        saveGate = gate
        gatedSaveCall = call
    }

    /// load 在**读到值之后**挂住：模拟一次慢的 Keychain 读——它读到的是那一刻的状态，
    /// 恢复时外面可能已经换了一条会话。
    func setLoadGate(_ gate: AsyncGate) {
        loadGate = gate
    }

    /// clear 在**清空之后**挂住：制造"Keychain 已经空了、登出还没从 await 里恢复"那一格
    /// 窗口。它是 `setSaveGate` 的镜像——代数不变式的两个入口（换新 / 清掉）各要一个闸门
    /// 才测得到。
    func setClearGate(_ gate: AsyncGate) {
        clearGate = gate
    }

    func currentToken() -> SessionToken? {
        stored
    }

    func load() async throws -> SessionToken? {
        loadCount += 1
        if failLoad {
            throw Boom()
        }
        let snapshot = stored
        if let loadGate {
            await loadGate.wait()
        }
        return snapshot
    }

    func save(_ token: SessionToken) async throws {
        saveCount += 1
        if failSave {
            throw Boom()
        }
        stored = token
        if let saveGate, saveCount == gatedSaveCall {
            await saveGate.wait()
        }
    }

    func clear() async throws {
        clearCount += 1
        if failClear {
            throw Boom()
        }
        stored = nil
        if let clearGate {
            await clearGate.wait()
        }
    }
}
