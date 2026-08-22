@testable import AgentCoordinator
import Foundation
import Testing

@Suite("AppConfiguration：base URL 与 Origin 头")
struct AppConfigurationTests {
    @Test("Origin 是 base URL 的源：scheme + host + 非默认端口")
    func derivesOriginWithExplicitPort() throws {
        let config = try AppConfiguration(apiBaseURL: #require(URL(string: "http://localhost:3001")))

        #expect(config.originHeaderValue == "http://localhost:3001")
    }

    @Test("默认端口按 origin 序列化规则省略")
    func omitsDefaultPorts() throws {
        let http = try AppConfiguration(apiBaseURL: #require(URL(string: "http://api.example.com:80")))
        let https = try AppConfiguration(apiBaseURL: #require(URL(string: "https://api.example.com:443")))
        let bare = try AppConfiguration(apiBaseURL: #require(URL(string: "https://api.example.com")))

        #expect(http.originHeaderValue == "http://api.example.com")
        #expect(https.originHeaderValue == "https://api.example.com")
        #expect(bare.originHeaderValue == "https://api.example.com")
    }

    @Test("Origin 不含路径、查询和片段")
    func stripsPathFromOrigin() throws {
        let config = try AppConfiguration(apiBaseURL: #require(URL(string: "https://example.com:8443/base/v1?x=1#f")))

        #expect(config.originHeaderValue == "https://example.com:8443")
    }

    @Test("host 大小写归一化为小写")
    func lowercasesHost() throws {
        let config = try AppConfiguration(apiBaseURL: #require(URL(string: "https://API.Example.COM")))

        #expect(config.originHeaderValue == "https://api.example.com")
    }

    @Test("缺 scheme 或 host 的 URL 直接 fail fast")
    func rejectsMalformedBaseURL() throws {
        #expect(throws: AppConfigurationError.self) {
            _ = try AppConfiguration(apiBaseURL: #require(URL(string: "localhost:3001")))
        }
        #expect(throws: AppConfigurationError.self) {
            _ = try AppConfiguration(apiBaseURL: #require(URL(string: "file:///tmp/x")))
        }
    }

    /// 刻意**不**断言某个构建配置的具体地址：那样 `-configuration Release` 跑测试必红，
    /// 而测试不该依赖用哪个 xcconfig。这里钉的是"xcconfig 的值原样落到运行时"这条链路
    /// （真实回归是 xcconfig 里 `//` 被当注释吃掉，Info.plist 拿到 `http:` 这种残值）。
    @Test("Info.plist 里的 APIBaseURL 原样落到运行时配置")
    func loadsFromBundle() throws {
        let raw = (Bundle.main.object(forInfoDictionaryKey: AppConfiguration.baseURLInfoKey) as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        guard !raw.isEmpty else {
            // Release 的 API_BASE_URL 故意留空（发版环境必须显式传值），此时只准 fail fast，
            // 不准兜底到某个猜测的地址。
            #expect(throws: AppConfigurationError.missingBaseURL) {
                _ = try AppConfiguration.load(from: .main)
            }
            return
        }

        let config = try AppConfiguration.load(from: .main)
        let expected = try AppConfiguration(apiBaseURL: #require(URL(string: raw)))

        #expect(config.apiBaseURL == expected.apiBaseURL)
        #expect(config.originHeaderValue == expected.originHeaderValue)
        #expect(config.apiBaseURL.host()?.isEmpty == false)
    }

    @Test("Bundle 里没有 APIBaseURL 时 fail fast，而不是兜底到某个地址")
    func failsWhenBundleKeyMissing() {
        #expect(throws: AppConfigurationError.missingBaseURL) {
            _ = try AppConfiguration.load(from: Bundle(for: EmptyBundleMarker.self))
        }
    }

    @Test("漏配的两种运维错误文案可区分，且都不把地址本身印在界面上")
    func misconfiguredCopyDistinguishesTheTwoOperationalMistakes() {
        let secretishURL = "https://api.internal.example/gateway"
        let missing = AuthCopy.misconfiguredDescription(for: .missingBaseURL)
        let malformed = AuthCopy.misconfiguredDescription(for: .malformedBaseURL(secretishURL))

        // 「根本没传值」和「传了个不合法的值」排查方向完全不同，界面得分得清
        #expect(missing != malformed)
        #expect(missing.isEmpty == false)
        #expect(malformed.isEmpty == false)

        // 那个地址可能是内网域名，截图一发就外流（security.md）
        #expect(malformed.contains(secretishURL) == false)
        #expect(malformed.contains("internal") == false)
    }

    @Test("endpoint 拼接不吃掉 base URL 的路径前缀")
    func buildsEndpointsUnderBasePath() throws {
        let config = try AppConfiguration(apiBaseURL: #require(URL(string: "https://example.com/gateway")))

        #expect(config.url(path: "/api/me").absoluteString == "https://example.com/gateway/api/me")
        #expect(
            config.url(path: "/api/auth/sign-in/email").absoluteString
                == "https://example.com/gateway/api/auth/sign-in/email"
        )
    }
}

/// 只用来拿一个"没有 APIBaseURL 键"的 Bundle（测试 bundle 自己）。
private final class EmptyBundleMarker {}
