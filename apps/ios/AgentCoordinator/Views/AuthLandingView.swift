import SwiftUI

/// 未登录时的入口。路由建模为 Hashable enum + 可编程 path，
/// 于是"冷启动直达注册页"只是构造一个 path（swiftui skill 步骤 4）。
enum AuthRoute: Hashable {
    case signUp
}

struct AuthLandingView: View {
    let authenticator: any AuthenticationPerforming

    @State private var path: [AuthRoute]

    init(authenticator: any AuthenticationPerforming, path: [AuthRoute] = []) {
        self.authenticator = authenticator
        _path = State(initialValue: path)
    }

    var body: some View {
        NavigationStack(path: $path) {
            AuthFormScreen(mode: .signIn, authenticator: authenticator) {
                path.append(.signUp)
            }
            .navigationTitle(AuthCopy.signInTitle)
            .navigationDestination(for: AuthRoute.self) { route in
                switch route {
                case .signUp:
                    AuthFormScreen(mode: .signUp, authenticator: authenticator, onSwitchMode: nil)
                        .navigationTitle(AuthCopy.signUpTitle)
                }
            }
        }
    }
}

#if DEBUG
    #Preview("登录") {
        AuthLandingView(authenticator: PreviewSupport.session(.unauthenticated))
    }

    // 冷启动直达注册页：路由是可编程状态，构造 path 即可（深链、推送落地页同理）。
    #Preview("直达注册页") {
        AuthLandingView(authenticator: PreviewSupport.session(.unauthenticated), path: [.signUp])
    }
#endif
