import Foundation
import Network

/// 本地回显 HTTP 服务器：把 App 真正发出去的那份请求头原样交回给测试。
///
/// **为什么必须是一个真的 socket。** `packages/contracts` 第 4 节有一条断言是按文档推断
/// 而不是实测的：原生 `URLSession` 不会自动补 `Sec-Fetch-*` / `Referer`。这条断言很关键——
/// api 侧实测过，`Sec-Fetch-Site: cross-site` + `Sec-Fetch-Mode: navigate` 会在**校验 Origin
/// 之前**就 403，可信 Origin 也救不回来；真补上了，线上表现就是 sign-in 全量 403，
/// 而客户端不可热修。要验证它只能看网络上真实流过去的字节：`URLProtocol` 之类的拦截发生在
/// CFNetwork 补默认头**之前**，看到的不是最终那份请求。
///
/// 服务器起在进程内、端口由系统分配，不依赖任何外部进程，所以这套探针留在默认 scheme 里
/// 每次 CI 都跑——`Sec-Fetch-*` 是平台行为，会随 iOS 版本变，需要长期有人盯着。
///
/// `Network` 框架的回调必须给一个 `DispatchQueue`，这是框架的投递方式；本文件把它整个
/// 包在 async 接口后面，测试侧只有 async/await（`.claude/rules/swift.md` 的并发模型统一）。
final class LoopbackEchoServer: @unchecked Sendable {
    enum ServerError: Error, Equatable {
        case notReady
        case listenerFailed(String)
    }

    /// 一次收到的请求头。
    struct CapturedRequest: Sendable {
        let requestLine: String
        /// 头名统一小写（HTTP 头名大小写不敏感）→ 值。
        let headers: [String: String]

        init(head: String) {
            var lines = head.components(separatedBy: "\r\n")
            requestLine = lines.isEmpty ? "" : lines.removeFirst()

            var parsed: [String: String] = [:]
            for line in lines {
                guard let colon = line.firstIndex(of: ":") else { continue }
                let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
                let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                guard !name.isEmpty else { continue }
                // 同名头按 HTTP 语义折叠成逗号分隔，不要悄悄丢掉后一个
                parsed[name] = parsed[name].map { "\($0), \(value)" } ?? value
            }
            headers = parsed
        }

        func header(_ name: String) -> String? {
            headers[name.lowercased()]
        }

        /// 实测到的全部头名（小写、排序），断言失败时直接把现场打出来。
        var headerNames: [String] {
            headers.keys.sorted()
        }
    }

    private let listener: NWListener
    private let queue = DispatchQueue(label: "dev.agentcoordinator.tests.loopback-echo")
    private let inbox = RequestInbox()
    private let ready = AsyncGate()
    private let startFailure = FailureBox()

    init() throws {
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        listener = try NWListener(using: parameters, on: .any)
    }

    /// 起服务并等到真的 ready；起不来就抛，绝不让测试挂死等一个永远不会来的连接。
    func start() async throws {
        listener.stateUpdateHandler = { [ready, startFailure] state in
            switch state {
            case .ready:
                Task { await ready.open() }
            case let .failed(error):
                startFailure.set(error.localizedDescription)
                Task { await ready.open() }
            default:
                break
            }
        }
        listener.newConnectionHandler = { [inbox, queue] connection in
            EchoConnection(connection: connection, inbox: inbox).start(on: queue)
        }
        listener.start(queue: queue)

        await ready.wait()
        if let message = startFailure.value {
            throw ServerError.listenerFailed(message)
        }
    }

    func stop() {
        listener.cancel()
    }

    /// 系统分配的端口。用 `localhost` 而不是 IP 字面量：Info.plist 的
    /// `NSAllowsLocalNetworking` 放行的就是这类本机地址。
    func baseURL() throws -> URL {
        guard let port = listener.port?.rawValue,
              let url = URL(string: "http://localhost:\(port)")
        else { throw ServerError.notReady }
        return url
    }

    /// 取下一个收到的请求（还没来就等）。
    func nextRequest() async -> CapturedRequest {
        await inbox.next()
    }
}

/// 收到的请求排队交给测试。
private actor RequestInbox {
    private var pending: [LoopbackEchoServer.CapturedRequest] = []
    private var waiter: CheckedContinuation<LoopbackEchoServer.CapturedRequest, Never>?

    func deliver(_ request: LoopbackEchoServer.CapturedRequest) {
        if let waiter {
            self.waiter = nil
            waiter.resume(returning: request)
        } else {
            pending.append(request)
        }
    }

    func next() async -> LoopbackEchoServer.CapturedRequest {
        if !pending.isEmpty {
            return pending.removeFirst()
        }
        return await withCheckedContinuation { waiter = $0 }
    }
}

/// listener 起不来时的错误信息。回调在 `DispatchQueue` 上，所以要自己上锁。
private final class FailureBox: @unchecked Sendable {
    private let lock = NSLock()
    private var message: String?

    var value: String? {
        lock.withLock { message }
    }

    func set(_ message: String) {
        lock.withLock { self.message = message }
    }
}

/// 一条连接：读满请求头（含 body，避免我们抢先回包把客户端的写打断）后交给 inbox，
/// 回一个最小的 200，然后关掉。
private final class EchoConnection: @unchecked Sendable {
    private enum Outcome {
        case keepReading
        case complete(LoopbackEchoServer.CapturedRequest)
    }

    private static let headTerminator = Data("\r\n\r\n".utf8)

    private let connection: NWConnection
    private let inbox: RequestInbox
    private let lock = NSLock()
    private var buffer = Data()

    init(connection: NWConnection, inbox: RequestInbox) {
        self.connection = connection
        self.inbox = inbox
    }

    func start(on queue: DispatchQueue) {
        connection.start(queue: queue)
        receive()
    }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [self] data, _, isComplete, error in
            let outcome = absorb(data)
            switch outcome {
            case let .complete(request):
                Task { await inbox.deliver(request) }
                respond()
            case .keepReading:
                if error != nil || isComplete {
                    connection.cancel()
                } else {
                    receive()
                }
            }
        }
    }

    private func absorb(_ data: Data?) -> Outcome {
        lock.withLock {
            if let data {
                buffer.append(data)
            }
            guard let terminator = buffer.range(of: Self.headTerminator) else { return .keepReading }
            guard let head = String(bytes: buffer[buffer.startIndex ..< terminator.lowerBound], encoding: .utf8) else {
                // HTTP 头本该是 ASCII，解不出来说明连接上的字节不是我们发的那份请求。
                // 交一个空请求上去让断言立刻失败，而不是让测试挂在 nextRequest() 上等一个不会来的请求。
                return .complete(LoopbackEchoServer.CapturedRequest(head: ""))
            }
            let request = LoopbackEchoServer.CapturedRequest(head: head)
            let expectedBody = Int(request.header("content-length") ?? "0") ?? 0
            let receivedBody = buffer.distance(from: terminator.upperBound, to: buffer.endIndex)
            return receivedBody >= expectedBody ? .complete(request) : .keepReading
        }
    }

    private func respond() {
        let body = Data(#"{"ok":true}"#.utf8)
        let head = "HTTP/1.1 200 OK\r\n"
            + "Content-Type: application/json\r\n"
            + "Content-Length: \(body.count)\r\n"
            + "Connection: close\r\n\r\n"
        var response = Data(head.utf8)
        response.append(body)
        connection.send(content: response, completion: .contentProcessed { [connection] _ in
            connection.cancel()
        })
    }
}
