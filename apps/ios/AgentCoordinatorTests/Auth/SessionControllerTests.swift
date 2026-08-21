@testable import AgentCoordinator
import Foundation
import Testing

@Suite("SessionController：会话守卫与五态")
@MainActor
struct SessionControllerTests {
    private func makeController(
        client: FakeAuthClient,
        store: FakeSessionTokenStore,
        initialState: SessionController.State = .loading
    ) -> SessionController {
        SessionController(client: client, tokenStore: store, initialState: initialState)
    }

    // MARK: - 冷启动（会话守卫）

    @Test("Keychain 里没有 token：直接未登录，不打 /api/me")
    func coldStartWithoutTokenGoesToSignIn() async {
        let client = FakeAuthClient()
        let store = FakeSessionTokenStore()
        let controller = makeController(client: client, store: store)

        await controller.refresh()

        #expect(controller.state == .unauthenticated)
        #expect(client.currentUserCallCount == 0)
    }

    @Test("有 token 且 /api/me 200：进已登录态，请求带的是存下来的那个 token")
    func coldStartWithValidTokenLoadsUser() async throws {
        let token = try TestFixtures.token()
        let client = FakeAuthClient()
        client.currentUserResults = [.success(TestFixtures.user)]
        let store = FakeSessionTokenStore(stored: token)
        let controller = makeController(client: client, store: store)

        await controller.refresh()

        #expect(controller.state == .loaded(TestFixtures.user))
        #expect(client.currentUserTokens.map(\.rawValue) == [token.rawValue])
    }

    @Test("200 但资料没有可展示内容：走空态，不是错误态")
    func coldStartWithBlankProfileShowsEmptyState() async throws {
        let client = FakeAuthClient()
        client.currentUserResults = [.success(TestFixtures.blankUser)]
        let store = try FakeSessionTokenStore(stored: TestFixtures.token())
        let controller = makeController(client: client, store: store)

        await controller.refresh()

        #expect(controller.state == .empty(TestFixtures.blankUser))
    }

    @Test("401：清 Keychain 回未登录态（唯一正确反应，不重试不追问原因）")
    func unauthenticatedClearsKeychain() async throws {
        let client = FakeAuthClient()
        client.currentUserResults = [.failure(.failure(.unauthenticated))]
        let store = try FakeSessionTokenStore(stored: TestFixtures.token())
        let controller = makeController(client: client, store: store)

        await controller.refresh()

        #expect(controller.state == .unauthenticated)
        #expect(await store.currentToken() == nil)
        #expect(await store.clearCount == 1)
    }

    @Test("限流不等于登出：保留 token，展示可读的等待时长")
    func rateLimitedKeepsSession() async throws {
        let token = try TestFixtures.token()
        let client = FakeAuthClient()
        client.currentUserResults = [.failure(.failure(.rateLimited(retryAfterSeconds: 45)))]
        let store = FakeSessionTokenStore(stored: token)
        let controller = makeController(client: client, store: store)

        await controller.refresh()

        #expect(controller.state == .failed(.rateLimited(retryAfterSeconds: 45)))
        #expect(await store.currentToken()?.rawValue == token.rawValue)
    }

    @Test("断网走离线态，token 保留")
    func offlineKeepsSession() async throws {
        let token = try TestFixtures.token()
        let client = FakeAuthClient()
        client.currentUserResults = [.failure(.transport(.offline))]
        let store = FakeSessionTokenStore(stored: token)
        let controller = makeController(client: client, store: store)

        await controller.refresh()

        #expect(controller.state == .offline)
        #expect(await store.currentToken()?.rawValue == token.rawValue)
    }

    @Test("5xx / 超时走可重试的错误态，不把用户踢去登录页")
    func serverErrorKeepsSession() async throws {
        let token = try TestFixtures.token()
        let client = FakeAuthClient()
        client.currentUserResults = [
            .failure(.failure(.server(status: 503))),
            .failure(.transport(.timedOut)),
        ]
        let store = FakeSessionTokenStore(stored: token)
        let controller = makeController(client: client, store: store)

        await controller.refresh()
        #expect(controller.state == .failed(.server(status: 503)))

        await controller.refresh()
        #expect(controller.state == .failed(.network))
        #expect(await store.currentToken()?.rawValue == token.rawValue)
    }

    @Test("Keychain 读失败：当作没有会话，不 crash")
    func keychainReadFailureFallsBackToSignIn() async {
        let client = FakeAuthClient()
        let store = FakeSessionTokenStore()
        await store.setFailures(load: true)
        let controller = makeController(client: client, store: store)

        await controller.refresh()

        #expect(controller.state == .unauthenticated)
        #expect(client.currentUserCallCount == 0)
    }

    @Test("重试后恢复：错误态能回到已登录态")
    func retryRecoversFromError() async throws {
        let client = FakeAuthClient()
        client.currentUserResults = [
            .failure(.failure(.server(status: 500))),
            .success(TestFixtures.user),
        ]
        let store = try FakeSessionTokenStore(stored: TestFixtures.token())
        let controller = makeController(client: client, store: store)

        await controller.refresh()
        #expect(controller.state == .failed(.server(status: 500)))

        await controller.refresh()
        #expect(controller.state == .loaded(TestFixtures.user))
    }

    @Test("刷新进行中重复触发不重复发请求")
    func concurrentRefreshIsCoalesced() async throws {
        let gate = AsyncGate()
        let client = FakeAuthClient()
        client.gate = gate
        client.currentUserResults = [.success(TestFixtures.user), .success(TestFixtures.user)]
        let store = try FakeSessionTokenStore(stored: TestFixtures.token())
        let controller = makeController(client: client, store: store)

        let first = Task { await controller.refresh() }
        // 让第一次请求进到 gate 里挂住
        while client.currentUserCallCount == 0 {
            await Task.yield()
        }
        await controller.refresh()
        await gate.open()
        await first.value

        #expect(client.currentUserCallCount == 1)
        #expect(controller.state == .loaded(TestFixtures.user))
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

    @Test("登出被限流：把等待秒数带到界面上")
    func signOutRateLimitedSurfacesCountdown() async throws {
        let client = FakeAuthClient()
        client.signOutOutcomes = [.failed(.failure(.rateLimited(retryAfterSeconds: 10)))]
        let store = try FakeSessionTokenStore(stored: TestFixtures.token())
        let controller = makeController(client: client, store: store, initialState: .loaded(TestFixtures.user))

        await controller.signOut()

        #expect(controller.signOutFailure == .rateLimited(retryAfterSeconds: 10))
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
