import SwiftUI

/// 会话守卫。五态在这里分派，每个态一个子视图。
struct RootView: View {
    let session: SessionController

    var body: some View {
        Group {
            switch session.state {
            case .loading:
                LoadingStateView(message: AuthCopy.checkingSession)

            case .unauthenticated:
                AuthLandingView(authenticator: session)

            case let .loaded(user):
                SignedInView(session: session, user: user, showsProfile: true)

            case let .empty(user):
                SignedInView(session: session, user: user, showsProfile: false)

            case let .failed(failure):
                FailureStateView(
                    failure: failure,
                    rateLimitDeadline: session.stateRateLimitDeadline
                ) { await session.refresh() }

            case .offline:
                OfflineStateView { await session.refresh() }
            }
        }
        // 冷启动读 Keychain → 打 /api/me 决定进哪个态。用 .task 而不是 onAppear：
        // 离屏自动取消，也不用自己管 Task 生命周期（swiftui skill 步骤 5）。
        .task { await session.refresh() }
    }
}
