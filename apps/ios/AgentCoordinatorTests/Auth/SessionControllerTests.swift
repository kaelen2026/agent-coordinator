@testable import AgentCoordinator
import Foundation
import Testing

@Suite("SessionController：会话守卫与五态")
@MainActor
struct SessionControllerTests {
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

    @Test("限流的错误态带出窗口截止时刻，倒计时视图据此续跑而不是重启")
    func rateLimitedStateCarriesDeadline() async throws {
        let clock = MutableClock()
        let client = FakeAuthClient()
        client.currentUserResults = [.failure(.failure(.rateLimited(retryAfterSeconds: 45)))]
        let store = try FakeSessionTokenStore(stored: TestFixtures.token())
        let controller = makeController(client: client, store: store, clock: clock)

        await controller.refresh()

        #expect(controller.stateRateLimitDeadline == clock.now().addingTimeInterval(45))
        // 登出那条通道没发生过限流，不该借用这个窗口
        #expect(controller.signOutRateLimitDeadline == nil)
    }

    @Test("错误态换成别的失败之后，上一次的限流窗口不再露出去")
    func rateLimitDeadlineIsNotShownForOtherFailures() async throws {
        let clock = MutableClock()
        let client = FakeAuthClient()
        client.currentUserResults = [
            .failure(.failure(.rateLimited(retryAfterSeconds: 45))),
            .failure(.failure(.server(status: 503))),
        ]
        let store = try FakeSessionTokenStore(stored: TestFixtures.token())
        let controller = makeController(client: client, store: store, clock: clock)

        await controller.refresh()
        #expect(controller.stateRateLimitDeadline != nil)

        await controller.refresh()

        #expect(controller.state == .failed(.server(status: 503)))
        #expect(controller.stateRateLimitDeadline == nil)
    }

    @Test("限流之后被判 401：错误态没了，上一次的限流窗口也不该再露出去")
    func rateLimitDeadlineIsNotShownAfterLeavingFailureState() async throws {
        let clock = MutableClock()
        let client = FakeAuthClient()
        client.currentUserResults = [
            .failure(.failure(.rateLimited(retryAfterSeconds: 45))),
            .failure(.failure(.unauthenticated)),
        ]
        let store = try FakeSessionTokenStore(stored: TestFixtures.token())
        let controller = makeController(client: client, store: store, clock: clock)

        await controller.refresh()
        #expect(controller.stateRateLimitDeadline != nil)

        await controller.refresh()

        // 界面已经不是错误态了，那个窗口跟现在这一屏没有任何关系
        #expect(controller.state == .unauthenticated)
        #expect(controller.stateRateLimitDeadline == nil)
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

    // MARK: - 后台刷新不清屏

    @Test("已有内容时刷新不切全屏 spinner：下拉刷新不该把列表和滚动位置一起丢掉")
    func refreshKeepsVisibleContentWhileLoading() async throws {
        let client = FakeAuthClient()
        client.currentUserResults = [.success(TestFixtures.user)]
        let store = try FakeSessionTokenStore(stored: TestFixtures.token())
        let controller = makeController(client: client, store: store, initialState: .loaded(TestFixtures.user))

        let gate = AsyncGate()
        client.gate = gate

        let refreshTask = Task { await controller.refresh() }
        while client.currentUserCallCount == 0 {
            await Task.yield()
        }

        // 请求还在飞的这一刻，屏幕上仍是原来那份内容
        #expect(controller.state == .loaded(TestFixtures.user))

        await gate.open()
        await refreshTask.value
        #expect(controller.state == .loaded(TestFixtures.user))
    }

    @Test("还没东西可展示时（冷启动 / 错误态重试）才切加载态")
    func refreshShowsLoadingWhenNothingToKeep() async throws {
        let client = FakeAuthClient()
        client.currentUserResults = [.success(TestFixtures.user)]
        let store = try FakeSessionTokenStore(stored: TestFixtures.token())
        let controller = makeController(
            client: client,
            store: store,
            initialState: .failed(.server(status: 503))
        )

        let gate = AsyncGate()
        client.gate = gate

        let refreshTask = Task { await controller.refresh() }
        while client.currentUserCallCount == 0 {
            await Task.yield()
        }

        #expect(controller.state == .loading)

        await gate.open()
        await refreshTask.value
        #expect(controller.state == .loaded(TestFixtures.user))
    }
}
