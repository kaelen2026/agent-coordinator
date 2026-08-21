#if DEBUG
    import Foundation

    /// Preview 专用的假依赖。用工厂函数而不是散落的字面量，方便和测试保持同一批样本
    /// （swiftui skill 最佳实践：每个 View 至少配正常/空/错误三个 Preview）。
    enum PreviewSupport {
        static let user = AuthUser(
            id: "usr_preview",
            email: "founder@example.com",
            name: "Founder",
            emailVerified: true,
            imageURL: nil,
            createdAt: "2026-08-21T10:11:12.000Z"
        )

        static let blankUser = AuthUser(
            id: "usr_preview",
            email: "",
            name: "",
            emailVerified: false,
            imageURL: nil,
            createdAt: ""
        )

        @MainActor
        static func session(_ state: SessionController.State) -> SessionController {
            SessionController(client: IdleAuthClient(), tokenStore: IdleTokenStore(), initialState: state)
        }

        /// 永不返回结果的 client：Preview 里点按钮不会真发请求，也不会把状态改掉。
        struct IdleAuthClient: AuthClient {
            func signUp(name _: String, email _: String, password _: String)
                async -> Result<SessionToken, AuthRequestError>
            {
                .failure(.transport(.offline))
            }

            func signIn(email _: String, password _: String)
                async -> Result<SessionToken, AuthRequestError>
            {
                .failure(.transport(.offline))
            }

            func signOut(token _: SessionToken) async -> SignOutOutcome {
                .failed(.transport(.offline))
            }

            func currentUser(token _: SessionToken)
                async -> Result<AuthUser, AuthRequestError>
            {
                .failure(.transport(.offline))
            }
        }

        struct IdleTokenStore: SessionTokenStore {
            func load() async throws -> SessionToken? {
                nil
            }

            func save(_: SessionToken) async throws {}
            func clear() async throws {}
        }
    }
#endif
