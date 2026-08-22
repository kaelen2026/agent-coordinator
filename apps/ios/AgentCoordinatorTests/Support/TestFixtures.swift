@testable import AgentCoordinator
import Foundation

enum TestFixtures {
    /// 本地 api 的地址。刻意不写成 `URL(string:)!` —— 全仓库零强制解包，
    /// 测试代码也不例外（swiftlint 0.65 的 force_unwrapping 抓不到这个写法，
    /// 所以这条只能靠纪律，不能靠工具）。
    static let baseURLString = "http://localhost:3001"

    static func baseURL() throws -> URL {
        guard let url = URL(string: baseURLString) else { throw FixtureError.invalidBaseURL }
        return url
    }

    static func configuration() throws -> AppConfiguration {
        try AppConfiguration(apiBaseURL: baseURL())
    }

    static func token(_ raw: String = ContractSamples.sessionTokenRaw) throws -> SessionToken {
        guard let token = SessionToken(rawValue: raw) else { throw FixtureError.invalidToken }
        return token
    }

    static let user = AuthUser(
        id: "usr_01HZX",
        email: "founder@example.com",
        name: "Founder",
        emailVerified: false,
        imageURL: nil,
        createdAt: "2026-08-21T10:11:12.000Z"
    )

    /// 第二个账号，用来测"换账号后旧请求迟到"这类跨操作交错。
    static let otherUser = AuthUser(
        id: "usr_01J0A",
        email: "second@example.com",
        name: "Second",
        emailVerified: true,
        imageURL: nil,
        createdAt: "2026-08-22T01:02:03.000Z"
    )

    static let blankUser = AuthUser(
        id: "usr_01HZX",
        email: "  ",
        name: "",
        emailVerified: false,
        imageURL: nil,
        createdAt: ""
    )

    enum FixtureError: Error {
        case invalidToken
        case invalidBaseURL
    }
}
