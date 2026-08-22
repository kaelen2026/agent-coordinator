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

    @Test("迟到的『Keychain 里没有 token』不许把新登录的会话打回未登录")
    func staleEmptyTokenLoadDoesNotOverrideNewerSignIn() async throws {
        // refresh 有两个出口：拿到 token（走 applyCurrentUser）和拿不到 token（直接判未登录）。
        // 两个出口都在 await 之后写 state，所以都要做代数比对——这条测的是后者。
        //
        // 目前**没有** UI 可达的触发路径：refresh 只从 RootView 的 .task（此时屏幕是 .loading，
        // 只有一个 spinner，够不着登录表单）和 .failed/.offline 的重试按钮、SignedInView 的
        // 下拉刷新发起，这几个态都不与登录表单同屏。所以它不是线上 bug，是纵深防御。
        // 这里从 controller 的公开 API 直接构造这个交错，把不变式钉住：将来任何一个界面在
        // 非 loading 态调 refresh，就会真的踩到这一格。
        let token = try TestFixtures.token()
        let client = FakeAuthClient()
        client.signInResults = [.success(token)]
        client.currentUserResults = [.success(TestFixtures.user)]
        let store = FakeSessionTokenStore() // 冷启动时 Keychain 是空的
        let loadGate = AsyncGate()
        await store.setLoadGate(loadGate)
        let controller = makeController(client: client, store: store, initialState: .loading)

        // 1. 冷启动的会话守卫开始读 Keychain，读得很慢（首次解锁后的 Keychain 可能要等）
        let refreshTask = Task { await controller.refresh() }
        while await store.loadCount == 0 {
            await Task.yield()
        }

        // 2. 这期间用户登录成功了，界面已经是已登录态
        let outcome = await controller.performSignIn(email: "founder@example.com", password: "pw")
        #expect(outcome == .authenticated)
        #expect(controller.state == .loaded(TestFixtures.user))

        // 3. 那次 Keychain 读这才返回——它读到的是登录**之前**那一刻的状态（没有 token），
        //    属于一条已经作废的会话，无权把用户打回登录页
        await loadGate.open()
        await refreshTask.value

        #expect(controller.state == .loaded(TestFixtures.user))
        #expect(await store.currentToken()?.rawValue == token.rawValue)
    }

    @Test("新凭证刚落盘的那一瞬间，迟到的 401 也不许把它清掉")
    func staleUnauthorizedDoesNotClearTokenBeingSaved() async throws {
        // 与 staleSignInDoesNotOverwriteLaterSignIn 同一条 UI 路径（登录页请求还在飞，
        // 切到注册页再提交一次），只是把镜头对准更窄的一格：token 已经写进 Keychain、
        // 抬高代数的那行还没执行。这一格里旧 401 的代数比对会通过，
        // 于是它清掉的是刚存进去的**新**凭证——界面显示已登录、Keychain 却空了，
        // 下次冷启动就是一次莫名的登出。
        let firstToken = try TestFixtures.token()
        let secondToken = try TestFixtures.token("st_second.secondsignature")
        let client = FakeAuthClient()
        client.signInResults = [.success(firstToken), .success(secondToken)]
        client.currentUserResults = [
            .failure(.failure(.unauthenticated)), // 第一条会话的 401，迟到
            .success(TestFixtures.otherUser),
        ]
        client.gatedCurrentUserCalls = 1
        let store = FakeSessionTokenStore()
        let saveGate = AsyncGate()
        await store.setSaveGate(saveGate, onCall: 2)
        let controller = makeController(client: client, store: store, initialState: .unauthenticated)

        let meGate = AsyncGate()
        client.gate = meGate

        // 1. 第一次登录：token 存下了，/api/me 还挂着
        let firstSignIn = Task {
            await controller.performSignIn(email: "founder@example.com", password: "pw")
        }
        while client.currentUserCallCount == 0 {
            await Task.yield()
        }

        // 2. 第二次登录：Keychain 里已经是 secondToken，调用方还挂在 save 的 await 里
        let secondSignIn = Task {
            await controller.performSignIn(email: "second@example.com", password: "pw")
        }
        while await store.saveCount < 2 {
            await Task.yield()
        }
        #expect(await store.currentToken()?.rawValue == secondToken.rawValue)

        // 3. 就在这个窗口里，第一条会话的 401 回来了
        await meGate.open()
        _ = await firstSignIn.value

        // 4. 第二次登录恢复，走完自己的 /api/me
        await saveGate.open()
        _ = await secondSignIn.value

        #expect(await store.currentToken()?.rawValue == secondToken.rawValue)
        #expect(controller.state == .loaded(TestFixtures.otherUser))
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
}
