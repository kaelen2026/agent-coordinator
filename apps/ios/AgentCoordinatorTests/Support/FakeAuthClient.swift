@testable import AgentCoordinator
import Foundation

/// 可编排的 AuthClient 假实现。
final class FakeAuthClient: AuthClient, @unchecked Sendable {
    private let lock = NSLock()

    var signUpResults: [Result<SessionToken, AuthRequestError>] = []
    var signInResults: [Result<SessionToken, AuthRequestError>] = []
    var signOutOutcomes: [SignOutOutcome] = []
    var currentUserResults: [Result<AuthUser, AuthRequestError>] = []

    private(set) var signInCalls: [(email: String, password: String)] = []
    private(set) var signUpCalls: [(name: String, email: String, password: String)] = []
    private(set) var signOutTokens: [SessionToken] = []
    private(set) var currentUserTokens: [SessionToken] = []

    var currentUserCallCount: Int {
        lock.withLock { currentUserTokens.count }
    }

    var signOutCallCount: Int {
        lock.withLock { signOutTokens.count }
    }

    /// 让请求在闸门打开前挂住，用来确定性地测"进行中"的状态与重入（不靠 sleep）。
    var gate: AsyncGate?
    var signOutGate: AsyncGate?

    func signUp(name: String, email: String, password: String) async -> Result<SessionToken, AuthRequestError> {
        lock.withLock {
            signUpCalls.append((name, email, password))
            return signUpResults.isEmpty ? .failure(.transport(.other)) : signUpResults.removeFirst()
        }
    }

    func signIn(email: String, password: String) async -> Result<SessionToken, AuthRequestError> {
        lock.withLock {
            signInCalls.append((email, password))
            return signInResults.isEmpty ? .failure(.transport(.other)) : signInResults.removeFirst()
        }
    }

    func signOut(token: SessionToken) async -> SignOutOutcome {
        let next: SignOutOutcome = lock.withLock {
            signOutTokens.append(token)
            return signOutOutcomes.isEmpty ? .failed(.transport(.other)) : signOutOutcomes.removeFirst()
        }
        if let signOutGate {
            await signOutGate.wait()
        }
        return next
    }

    func currentUser(token: SessionToken) async -> Result<AuthUser, AuthRequestError> {
        let next: Result<AuthUser, AuthRequestError> = lock.withLock {
            currentUserTokens.append(token)
            return currentUserResults.isEmpty ? .failure(.transport(.other)) : currentUserResults.removeFirst()
        }
        if let gate {
            await gate.wait()
        }
        return next
    }
}

/// 一个可以被外部放开的闸门，用来在测试里制造"请求还没回来"的窗口。
actor AsyncGate {
    private var continuations: [CheckedContinuation<Void, Never>] = []
    private var isOpen = false

    func wait() async {
        if isOpen {
            return
        }
        await withCheckedContinuation { continuations.append($0) }
    }

    func open() {
        isOpen = true
        let pending = continuations
        continuations = []
        for continuation in pending {
            continuation.resume()
        }
    }
}
