@testable import AgentCoordinator
import Foundation

/// 记录请求、按序回放响应的假传输层。只隔离网络这一个外部边界（testing.md）。
final class FakeHTTPTransport: HTTPTransport, @unchecked Sendable {
    enum Step: Sendable {
        case respond(HTTPResponse)
        case fail(TransportFailure)
    }

    private let lock = NSLock()
    private var steps: [Step]
    private(set) var recorded: [HTTPRequest] = []

    init(steps: [Step]) {
        self.steps = steps
    }

    convenience init(status: Int, headers: [String: String] = [:], body: Data = Data()) {
        self.init(steps: [.respond(HTTPResponse(status: status, headers: HTTPHeaders(headers), body: body))])
    }

    convenience init(failure: TransportFailure) {
        self.init(steps: [.fail(failure)])
    }

    var requestCount: Int {
        lock.withLock { recorded.count }
    }

    var lastRequest: HTTPRequest? {
        lock.withLock { recorded.last }
    }

    func request(at index: Int) -> HTTPRequest? {
        lock.withLock { index < recorded.count ? recorded[index] : nil }
    }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let step: Step = try lock.withLock {
            recorded.append(request)
            guard !steps.isEmpty else { throw FakeTransportExhausted() }
            return steps.removeFirst()
        }

        switch step {
        case let .respond(response): return response
        case let .fail(failure): throw failure
        }
    }
}

struct FakeTransportExhausted: Error {}
