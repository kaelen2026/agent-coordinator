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

    @Test("从 Bundle 读 APIBaseURL：xcconfig 的值能落到运行时")
    func loadsFromBundle() throws {
        let config = try AppConfiguration.load(from: .main)

        #expect(config.apiBaseURL.scheme == "http")
        #expect(config.originHeaderValue == "http://localhost:3001")
    }

    @Test("Bundle 里没有 APIBaseURL 时 fail fast，而不是兜底到某个地址")
    func failsWhenBundleKeyMissing() {
        #expect(throws: AppConfigurationError.missingBaseURL) {
            _ = try AppConfiguration.load(from: Bundle(for: EmptyBundleMarker.self))
        }
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
