import Foundation

/// `packages/contracts`: `authUserSchema` —— 服务端对外的用户字段白名单。
struct AuthUser: Decodable, Equatable, Sendable, Identifiable {
    let id: String
    let email: String
    let name: String
    let emailVerified: Bool
    let imageURL: URL?
    let createdAt: String

    init(id: String, email: String, name: String, emailVerified: Bool, imageURL: URL?, createdAt: String) {
        self.id = id
        self.email = email
        self.name = name
        self.emailVerified = emailVerified
        self.imageURL = imageURL
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case email
        case name
        case emailVerified
        case image
        case createdAt
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        // id 是这条数据的身份，缺了它整条无意义 —— 唯一严格要求的字段。
        id = try container.decode(String.self, forKey: .id)
        email = container.lenient(String.self, forKey: .email, default: "")
        name = container.lenient(String.self, forKey: .name, default: "")
        emailVerified = container.lenient(Bool.self, forKey: .emailVerified, default: false)
        createdAt = container.lenient(String.self, forKey: .createdAt, default: "")

        // 契约写的是 `z.string().url().nullable()`，但真给了非 URL（或空白）时只降级这一个
        // 字段：头像显示不出来无所谓，不能因此整个会话不可用。
        imageURL = Self.usableImageURL(container.lenientIfPresent(String.self, forKey: .image))
    }

    private static func usableImageURL(_ raw: String?) -> URL? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty,
              let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
              url.host?.isEmpty == false
        else { return nil }
        return url
    }

    /// 服务端 200 但资料没有任何可展示内容 —— 归到"空数据"态而不是渲染一片空白。
    var hasDisplayableProfile: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

/// `packages/contracts`: `meResponseSchema`
struct MeResponse: Decodable, Equatable, Sendable {
    let user: AuthUser
}
