@testable import AgentCoordinator
import Foundation
import Testing

/// 登录 / 注册 / 登出这三条**用户主动发起**的会话变更。
///
/// 与 `SessionControllerTests`（冷启动的会话守卫与五态）分文件是按内聚分的：那边测的是
/// "App 自己去问服务端我是谁"，这边测的是"用户按了一个按钮"，两组的夹具与关注点都不一样。
/// 跨这两组操作**交错**时的竞态在 `SessionControllerRaceTests`。
@Suite("SessionController：登录 / 注册 / 登出")
@MainActor
struct SessionControllerAuthFlowTests {
    private func makeController(
        client: FakeAuthClient,
        store: FakeSessionTokenStore,
        initialState: SessionController.State = .loading,
        clock: MutableClock? = nil
    ) -> SessionController {
        guard let clock else {
            return SessionController(client: client, tokenStore: store, initialState: initialState)
        }
        return SessionController(
            client: client,
            tokenStore: store,
            initialState: initialState,
            now: clock.now
        )
    }

    // MARK: - 登录 / 注册

    @Test("登录成功：token 存进 Keychain 并进已登录态")
    func signInStoresTokenAndLoadsUser() async throws {
        let token = try TestFixtures.token()
        let client = FakeAuthClient()
        client.signInResults = [.success(token)]
        client.currentUserResults = [.success(TestFixtures.user)]
        let store = FakeSessionTokenStore()
        let controller = makeController(client: client, store: store)

        let outcome = await controller.performSignIn(email: "founder@example.com", password: "pw")

        #expect(outcome == .authenticated)
        #expect(await store.currentToken()?.rawValue == token.rawValue)
        #expect(controller.state == .loaded(TestFixtures.user))
    }

    @Test("登录时邮箱先 trim 再发，省一次注定失败的往返")
    func signInTrimsEmail() async throws {
        let client = FakeAuthClient()
        client.signInResults = try [.success(TestFixtures.token())]
        client.currentUserResults = [.success(TestFixtures.user)]
        let controller = makeController(client: client, store: FakeSessionTokenStore())

        _ = await controller.performSignIn(email: "  founder@example.com  ", password: "pw")

        #expect(client.signInCalls.first?.email == "founder@example.com")
    }

    @Test("登录失败：Keychain 里不留任何东西，状态仍是未登录")
    func signInFailureLeavesNoToken() async {
        let client = FakeAuthClient()
        client.signInResults = [.failure(.failure(.invalidCredentials))]
        let store = FakeSessionTokenStore()
        let controller = makeController(client: client, store: store, initialState: .unauthenticated)

        let outcome = await controller.performSignIn(email: "a@b.co", password: "wrong")

        #expect(outcome == .failed(.remote(.invalidCredentials)))
        #expect(await store.currentToken() == nil)
        #expect(await store.saveCount == 0)
        #expect(controller.state == .unauthenticated)
        #expect(client.currentUserCallCount == 0)
    }

    @Test("注册成功：与登录同一条路径")
    func signUpStoresTokenAndLoadsUser() async throws {
        let token = try TestFixtures.token()
        let client = FakeAuthClient()
        client.signUpResults = [.success(token)]
        client.currentUserResults = [.success(TestFixtures.user)]
        let store = FakeSessionTokenStore()
        let controller = makeController(client: client, store: store)

        let outcome = await controller.performSignUp(name: "Founder", email: "a@b.co", password: "pw")

        #expect(outcome == .authenticated)
        #expect(await store.currentToken()?.rawValue == token.rawValue)
        #expect(controller.state == .loaded(TestFixtures.user))
        #expect(client.signUpCalls.first?.name == "Founder")
    }

    @Test("注册时姓名也 trim")
    func signUpTrimsName() async throws {
        let client = FakeAuthClient()
        client.signUpResults = try [.success(TestFixtures.token())]
        client.currentUserResults = [.success(TestFixtures.user)]
        let controller = makeController(client: client, store: FakeSessionTokenStore())

        _ = await controller.performSignUp(name: "  Founder  ", email: " a@b.co ", password: "pw")

        #expect(client.signUpCalls.first?.name == "Founder")
        #expect(client.signUpCalls.first?.email == "a@b.co")
    }

    @Test("拿到 token 但存不进 Keychain：报存储不可用，不进已登录态")
    func signInWithUnwritableKeychainFails() async throws {
        let client = FakeAuthClient()
        client.signInResults = try [.success(TestFixtures.token())]
        let store = FakeSessionTokenStore()
        await store.setFailures(save: true)
        let controller = makeController(client: client, store: store, initialState: .unauthenticated)

        let outcome = await controller.performSignIn(email: "a@b.co", password: "pw")

        #expect(outcome == .failed(.storageUnavailable))
        #expect(controller.state == .unauthenticated)
        #expect(client.currentUserCallCount == 0)
    }

    @Test("登录成功但随后 /api/me 401：不静默停在登录页，会话按未登录清干净")
    func signInThenSessionGoneClearsToken() async throws {
        let client = FakeAuthClient()
        client.signInResults = try [.success(TestFixtures.token())]
        client.currentUserResults = [.failure(.failure(.unauthenticated))]
        let store = FakeSessionTokenStore()
        let controller = makeController(client: client, store: store)

        let outcome = await controller.performSignIn(email: "a@b.co", password: "pw")

        #expect(outcome == .failed(.remote(.unauthenticated)))
        #expect(await store.currentToken() == nil)
        #expect(controller.state == .unauthenticated)
    }

    @Test("登录成功但 /api/me 断网：仍算登录成功（token 已存），界面走离线态")
    func signInThenOfflineStaysAuthenticated() async throws {
        let token = try TestFixtures.token()
        let client = FakeAuthClient()
        client.signInResults = [.success(token)]
        client.currentUserResults = [.failure(.transport(.offline))]
        let store = FakeSessionTokenStore()
        let controller = makeController(client: client, store: store)

        let outcome = await controller.performSignIn(email: "a@b.co", password: "pw")

        #expect(outcome == .authenticated)
        #expect(controller.state == .offline)
        #expect(await store.currentToken()?.rawValue == token.rawValue)
    }

    // MARK: - 登出

    @Test("登出 200：清 Keychain 回登录页")
    func signOutClearsKeychain() async throws {
        let client = FakeAuthClient()
        client.signOutOutcomes = [.signedOut]
        let store = try FakeSessionTokenStore(stored: TestFixtures.token())
        let controller = makeController(client: client, store: store, initialState: .loaded(TestFixtures.user))

        await controller.signOut()

        #expect(controller.state == .unauthenticated)
        #expect(await store.currentToken() == nil)
        #expect(controller.signOutFailure == nil)
        #expect(controller.isSigningOut == false)
    }

    @Test("token 已失效时服务端回 200：登出仍算成功，不给用户弹失败（幂等语义）")
    func signOutWithStaleTokenIsIdempotent() async throws {
        let client = FakeAuthClient()
        client.signOutOutcomes = [.signedOut]
        let store = try FakeSessionTokenStore(stored: TestFixtures.token())
        let controller = makeController(client: client, store: store, initialState: .loaded(TestFixtures.user))

        await controller.signOut()

        #expect(controller.state == .unauthenticated)
        #expect(controller.signOutFailure == nil)
    }

    @Test("本地已经没有 token：登出直接回登录页，不发请求")
    func signOutWithoutTokenSkipsRequest() async {
        let client = FakeAuthClient()
        let store = FakeSessionTokenStore()
        let controller = makeController(client: client, store: store, initialState: .loaded(TestFixtures.user))

        await controller.signOut()

        #expect(controller.state == .unauthenticated)
        #expect(client.signOutCallCount == 0)
    }

    @Test("登出失败（5xx/断网/限流）：不假装登出，保留 token 与已登录态")
    func signOutFailureKeepsSession() async throws {
        let token = try TestFixtures.token()
        let client = FakeAuthClient()
        client.signOutOutcomes = [.failed(.failure(.server(status: 503)))]
        let store = FakeSessionTokenStore(stored: token)
        let controller = makeController(client: client, store: store, initialState: .loaded(TestFixtures.user))

        await controller.signOut()

        #expect(controller.state == .loaded(TestFixtures.user))
        #expect(controller.signOutFailure == .server(status: 503))
        #expect(await store.currentToken()?.rawValue == token.rawValue)
    }

    @Test("登出被限流：把等待窗口带到界面上")
    func signOutRateLimitedSurfacesCountdown() async throws {
        let clock = MutableClock()
        let client = FakeAuthClient()
        client.signOutOutcomes = [.failed(.failure(.rateLimited(retryAfterSeconds: 10)))]
        let store = try FakeSessionTokenStore(stored: TestFixtures.token())
        let controller = makeController(
            client: client,
            store: store,
            initialState: .loaded(TestFixtures.user),
            clock: clock
        )

        await controller.signOut()

        #expect(controller.signOutFailure == .rateLimited(retryAfterSeconds: 10))
        #expect(controller.signOutRateLimitDeadline == clock.now().advanced(by: .seconds(10)))
        #expect(controller.stateRateLimitDeadline == nil)
    }

    @Test("登出失败换成别的错误之后，上一次的限流窗口不再露出去")
    func signOutRateLimitDeadlineIsNotShownForOtherFailures() async throws {
        let clock = MutableClock()
        let client = FakeAuthClient()
        client.signOutOutcomes = [
            .failed(.failure(.rateLimited(retryAfterSeconds: 10))),
            .failed(.transport(.offline)),
        ]
        let store = try FakeSessionTokenStore(stored: TestFixtures.token())
        let controller = makeController(
            client: client,
            store: store,
            initialState: .loaded(TestFixtures.user),
            clock: clock
        )

        await controller.signOut()
        #expect(controller.signOutRateLimitDeadline != nil)

        await controller.signOut()

        #expect(controller.signOutFailure == .network)
        #expect(controller.signOutRateLimitDeadline == nil)
    }

    @Test("登出终于成功之后，上一次的限流窗口不再露出去")
    func signOutRateLimitDeadlineIsNotShownAfterSuccess() async throws {
        let clock = MutableClock()
        let client = FakeAuthClient()
        client.signOutOutcomes = [.failed(.failure(.rateLimited(retryAfterSeconds: 10))), .signedOut]
        let store = try FakeSessionTokenStore(stored: TestFixtures.token())
        let controller = makeController(
            client: client,
            store: store,
            initialState: .loaded(TestFixtures.user),
            clock: clock
        )

        await controller.signOut()
        #expect(controller.signOutRateLimitDeadline != nil)

        await controller.signOut()

        #expect(controller.signOutFailure == nil)
        #expect(controller.signOutRateLimitDeadline == nil)
    }

    @Test("再次登出前清掉上一次的失败提示")
    func signOutClearsPreviousFailure() async throws {
        let client = FakeAuthClient()
        client.signOutOutcomes = [.failed(.transport(.offline)), .signedOut]
        let store = try FakeSessionTokenStore(stored: TestFixtures.token())
        let controller = makeController(client: client, store: store, initialState: .loaded(TestFixtures.user))

        await controller.signOut()
        #expect(controller.signOutFailure == .network)

        await controller.signOut()
        #expect(controller.signOutFailure == nil)
        #expect(controller.state == .unauthenticated)
    }

    @Test("登出进行中重复点击只发一次请求")
    func concurrentSignOutIsCoalesced() async throws {
        let client = FakeAuthClient()
        client.signOutOutcomes = [.signedOut, .signedOut]
        let store = try FakeSessionTokenStore(stored: TestFixtures.token())
        let controller = makeController(client: client, store: store, initialState: .loaded(TestFixtures.user))

        let gate = AsyncGate()
        client.signOutGate = gate

        let first = Task { await controller.signOut() }
        while client.signOutCallCount == 0 {
            await Task.yield()
        }
        await controller.signOut()
        await gate.open()
        await first.value

        #expect(client.signOutCallCount == 1)
        #expect(controller.state == .unauthenticated)
    }
}
