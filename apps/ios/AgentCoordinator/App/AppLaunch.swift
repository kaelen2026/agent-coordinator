import Foundation

/// 组装层：所有外部依赖在这里构造一次，往下注入。
/// 业务代码不就地 new URLSession / Keychain（architecture.md：依赖注入）。
enum AppLaunch {
    case ready(SessionController)
    /// Info.plist 里没有可用的 api 地址。宁可显式停在一个说明页，也不兜底到某个猜测的地址。
    case misconfigured(AppConfigurationError)

    @MainActor
    static func live(bundle: Bundle = .main) -> AppLaunch {
        do {
            let configuration = try AppConfiguration.load(from: bundle)
            let transport = URLSessionTransport(session: URLSessionTransport.makeSession())

            return .ready(SessionController(
                client: LiveAuthClient(configuration: configuration, transport: transport),
                tokenStore: KeychainSessionTokenStore(service: keychainService(bundle: bundle))
            ))
        } catch let error as AppConfigurationError {
            return .misconfigured(error)
        } catch {
            return .misconfigured(.missingBaseURL)
        }
    }

    private static func keychainService(bundle: Bundle) -> String {
        "\(bundle.bundleIdentifier ?? "dev.agentcoordinator.ios").session"
    }
}
