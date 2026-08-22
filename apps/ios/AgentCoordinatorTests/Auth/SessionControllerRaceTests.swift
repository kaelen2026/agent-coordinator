@testable import AgentCoordinator
import Foundation
import Testing

/// 跨操作交错的竞态。
///
/// `SessionControllerTests` 里的 `concurrent*IsCoalesced` 只覆盖同一个操作的重入。
/// 真正咬人的是两个**不同**操作交错：`isRefreshing` 与 `isSigningOut` 是两把互不相干
/// 的锁，谁也拦不住对方，在飞的 `/api/me` 回来时会把已经作废的会话写回 `state`。
@Suite("SessionController：跨操作交错的会话竞态")
@MainActor
struct SessionControllerRaceTests {
    private func makeController(
        client: FakeAuthClient,
        store: FakeSessionTokenStore,
        initialState: SessionController.State = .loading
    ) -> SessionController {
        SessionController(client: client, tokenStore: store, initialState: initialState)
    }

    @Test("登出成功后，还在飞的 /api/me 不应把状态写回已登录")
    func inFlightRefreshCannotResurrectSignedOutSession() async throws {
        let client = FakeAuthClient()
        client.signOutOutcomes = [.signedOut]
        client.currentUserResults = [.success(TestFixtures.user)]
        let store = try FakeSessionTokenStore(stored: TestFixtures.token())
        let controller = makeController(client: client, store: store, initialState: .loaded(TestFixtures.user))

        let meGate = AsyncGate()
        client.gate = meGate

        // 1. 用户下拉刷新：拿旧 token 发出 /api/me，请求还挂着没回来
        let refreshTask = Task { await controller.refresh() }
        while client.currentUserCallCount == 0 {
            await Task.yield()
        }

        // 2. 用户点登出：登出先返回，清 Keychain、回登录页
        await controller.signOut()
        #expect(controller.state == .unauthenticated)

        // 3. 那个 /api/me 这才 200 回来——凭证已删、用户已登出，它无权把状态写回去
        await meGate.open()
        await refreshTask.value

        #expect(controller.state == .unauthenticated)
        #expect(await store.currentToken() == nil)
    }

    @Test("登出进行中的刷新不发请求：结果注定要丢，白吃一次限流额度")
    func refreshDuringSignOutIsSkipped() async throws {
        let client = FakeAuthClient()
        client.signOutOutcomes = [.signedOut]
        client.currentUserResults = [.success(TestFixtures.user)]
        let store = try FakeSessionTokenStore(stored: TestFixtures.token())
        let controller = makeController(client: client, store: store, initialState: .loaded(TestFixtures.user))

        let signOutGate = AsyncGate()
        let meGate = AsyncGate()
        client.signOutGate = signOutGate
        client.gate = meGate

        // 1. 点登出，请求慢，界面还停在 SignedInView，下拉刷新仍够得着
        let signOutTask = Task { await controller.signOut() }
        while client.signOutCallCount == 0 {
            await Task.yield()
        }

        // 2. 用户下拉刷新。修好之后它会在守卫处直接返回（永远等不到 currentUserCallCount > 0），
        //    所以只给固定次数的调度让步，不做无界等待。
        let refreshTask = Task { await controller.refresh() }
        for _ in 0 ..< 200 where client.currentUserCallCount == 0 {
            await Task.yield()
        }

        // 3. 登出返回 → 未登录态
        await signOutGate.open()
        await signOutTask.value
        #expect(controller.state == .unauthenticated)

        // 4. 迟到的 /api/me（如果真发出去了）不得把状态写回已登录
        await meGate.open()
        await refreshTask.value

        #expect(client.currentUserCallCount == 0)
        #expect(controller.state == .unauthenticated)
        #expect(await store.currentToken() == nil)
    }

    @Test("换账号：上一个会话迟到的 /api/me 不覆盖新登录的账号")
    func staleCurrentUserDoesNotOverwriteNewerSession() async throws {
        let oldToken = try TestFixtures.token()
        let newToken = try TestFixtures.token("st_new.newsignature")
        let client = FakeAuthClient()
        client.signOutOutcomes = [.signedOut]
        client.signInResults = [.success(newToken)]
        client.currentUserResults = [.success(TestFixtures.user), .success(TestFixtures.otherUser)]
        // 只挂住第一次 /api/me（旧账号那次），第二次（新账号）照常返回
        client.gatedCurrentUserCalls = 1
        let store = FakeSessionTokenStore(stored: oldToken)
        let controller = makeController(client: client, store: store, initialState: .loaded(TestFixtures.user))

        let meGate = AsyncGate()
        client.gate = meGate

        // 1. 旧账号的刷新还在飞
        let refreshTask = Task { await controller.refresh() }
        while client.currentUserCallCount == 0 {
            await Task.yield()
        }

        // 2. 用户登出，换另一个账号登录，界面已经是第二个账号
        await controller.signOut()
        let outcome = await controller.performSignIn(email: "second@example.com", password: "pw")
        #expect(outcome == .authenticated)
        #expect(controller.state == .loaded(TestFixtures.otherUser))

        // 3. 第一个账号的 /api/me 这才回来——它属于一条已经作废的会话
        await meGate.open()
        await refreshTask.value

        #expect(controller.state == .loaded(TestFixtures.otherUser))
        #expect(await store.currentToken()?.rawValue == newToken.rawValue)
    }

    @Test("连着两次登录：先发的那次迟到，不覆盖后发那次的账号")
    func staleSignInDoesNotOverwriteLaterSignIn() async throws {
        // UI 可达：登录页提交后请求还在飞，用户切到注册页（提交用的是不受视图生命周期
        // 约束的 Task）再提交一次，两条 adoptSession 就交错了。
        let firstToken = try TestFixtures.token()
        let secondToken = try TestFixtures.token("st_second.secondsignature")
        let client = FakeAuthClient()
        client.signInResults = [.success(firstToken), .success(secondToken)]
        client.currentUserResults = [.success(TestFixtures.user), .success(TestFixtures.otherUser)]
        client.gatedCurrentUserCalls = 1 // 只挂住第一次登录的 /api/me
        let store = FakeSessionTokenStore()
        let controller = makeController(client: client, store: store, initialState: .unauthenticated)

        let meGate = AsyncGate()
        client.gate = meGate

        let firstSignIn = Task {
            await controller.performSignIn(email: "founder@example.com", password: "pw")
        }
        while client.currentUserCallCount == 0 {
            await Task.yield()
        }

        // 第二次登录整程跑完，界面已经是第二个账号
        _ = await controller.performSignIn(email: "second@example.com", password: "pw")
        #expect(controller.state == .loaded(TestFixtures.otherUser))

        await meGate.open()
        _ = await firstSignIn.value

        #expect(controller.state == .loaded(TestFixtures.otherUser))
        #expect(await store.currentToken()?.rawValue == secondToken.rawValue)
    }

    @Test("迟到的 401 属于旧会话，不许清掉新会话的凭证")
    func staleUnauthorizedDoesNotClearNewerSession() async throws {
        let oldToken = try TestFixtures.token()
        let newToken = try TestFixtures.token("st_new.newsignature")
        let client = FakeAuthClient()
        client.signOutOutcomes = [.signedOut]
        client.signInResults = [.success(newToken)]
        client.currentUserResults = [
            .failure(.failure(.unauthenticated)), // 旧会话的 401，迟到
            .success(TestFixtures.otherUser),
        ]
        client.gatedCurrentUserCalls = 1
        let store = FakeSessionTokenStore(stored: oldToken)
        let controller = makeController(client: client, store: store, initialState: .loaded(TestFixtures.user))

        let meGate = AsyncGate()
        client.gate = meGate

        let refreshTask = Task { await controller.refresh() }
        while client.currentUserCallCount == 0 {
            await Task.yield()
        }

        await controller.signOut()
        _ = await controller.performSignIn(email: "second@example.com", password: "pw")

        await meGate.open()
        await refreshTask.value

        #expect(controller.state == .loaded(TestFixtures.otherUser))
        #expect(await store.currentToken()?.rawValue == newToken.rawValue)
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
