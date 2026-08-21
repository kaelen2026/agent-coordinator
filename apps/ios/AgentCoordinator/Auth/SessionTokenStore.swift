import Foundation
import Security

/// 会话凭证的持久化。
///
/// `.claude/rules/swift.md`（BLOCKER 条款）：token 只进 Keychain，禁止 UserDefaults /
/// 明文文件。接口是 async 的，因为 Keychain 是进程外调用，不该占着主线程。
protocol SessionTokenStore: Sendable {
    func load() async throws -> SessionToken?
    func save(_ token: SessionToken) async throws
    func clear() async throws
}

enum KeychainError: Error, Equatable {
    /// 只带 OSStatus，**不带 token 内容** —— 错误信息会进日志。
    case unexpectedStatus(OSStatus)
    case malformedData
}

/// Keychain 实现。用 actor 让 SecItem 调用离开主线程，同时天然串行化读写。
actor KeychainSessionTokenStore: SessionTokenStore {
    private let service: String
    private let account: String

    init(service: String, account: String = "session-token") {
        self.service = service
        self.account = account
    }

    func load() async throws -> SessionToken? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else { throw KeychainError.unexpectedStatus(status) }

        // 外部数据：一律不强制解包（swift.md）。
        guard let data = item as? Data,
              let raw = String(data: data, encoding: .utf8),
              let token = SessionToken(rawValue: raw)
        else { throw KeychainError.malformedData }

        return token
    }

    func save(_ token: SessionToken) async throws {
        guard let data = token.rawValue.data(using: .utf8) else { throw KeychainError.malformedData }

        // 先删再加：避免 update / add 两条分支各自处理"已存在/不存在"。
        // 已经不存在时返回 errSecItemNotFound，对这里不是错误。
        let deleteStatus = SecItemDelete(baseQuery() as CFDictionary)
        guard deleteStatus == errSecSuccess || deleteStatus == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(deleteStatus)
        }

        var attributes = baseQuery()
        attributes[kSecValueData as String] = data
        // ThisDeviceOnly：不进 iCloud Keychain、不随备份迁到别的设备。
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly

        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.unexpectedStatus(status) }
    }

    func clear() async throws {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        // 本来就没有 = 已经是想要的状态，登出要幂等。
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(status)
        }
    }

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
