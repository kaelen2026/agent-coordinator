@testable import AgentCoordinator
import Foundation
import Testing

@Suite("URLSession 配置：凭证不落盘、不带 cookie、有超时")
struct URLSessionTransportTests {
    @Test("ephemeral 配置：cache/cookie/credential 只在内存")
    func usesEphemeralConfiguration() {
        let configuration = URLSessionTransport.makeConfiguration()

        #expect(configuration.urlCache == nil)
        #expect(configuration.httpCookieStorage == nil)
        #expect(configuration.httpShouldSetCookies == false)
        #expect(configuration.httpCookieAcceptPolicy == .never)
        #expect(configuration.requestCachePolicy == .reloadIgnoringLocalCacheData)
    }

    @Test("所有出站请求都有超时（security.md：没有超时的网络调用视为 bug）")
    func setsTimeouts() {
        let configuration = URLSessionTransport.makeConfiguration()

        #expect(configuration.timeoutIntervalForRequest == 15)
        #expect(configuration.timeoutIntervalForResource == 30)
    }
}

@Suite("TransportFailure 分类")
struct TransportFailureTests {
    @Test("设备确实没网才算离线")
    func classifiesOffline() {
        for code in [
            URLError.Code.notConnectedToInternet,
            .networkConnectionLost,
            .dataNotAllowed,
            .internationalRoamingOff,
        ] {
            #expect(TransportFailure.classify(URLError(code)) == .offline, "\(code.rawValue)")
        }
    }

    @Test("服务端没起 / DNS 解析失败不算离线：别让用户去查 WiFi")
    func serverDownIsNotOffline() {
        #expect(TransportFailure.classify(URLError(.cannotConnectToHost)) == .other)
        #expect(TransportFailure.classify(URLError(.cannotFindHost)) == .other)
        #expect(TransportFailure.classify(URLError(.dnsLookupFailed)) == .other)
    }

    @Test("超时与取消各自成一类")
    func classifiesTimeoutAndCancellation() {
        #expect(TransportFailure.classify(URLError(.timedOut)) == .timedOut)
        #expect(TransportFailure.classify(URLError(.cancelled)) == .cancelled)
        #expect(TransportFailure.classify(CancellationError()) == .cancelled)
    }

    @Test("非 URLError 归为 other")
    func classifiesUnknownErrors() {
        struct Boom: Error {}
        #expect(TransportFailure.classify(Boom()) == .other)
    }
}
