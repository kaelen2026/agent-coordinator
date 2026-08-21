import Foundation

/// 契约样本。取自 `packages/contracts/src/index.ts` 的 schema 与其中记录的实测响应，
/// 测试与 Preview 共用一份，避免两处漂移。
enum ContractSamples {
    /// 契约里给出的真实 token 形状：`<会话 id>.<标准 base64 HMAC 签名>`，含 `+` `/` `=`。
    static let sessionTokenRaw =
        "XixGaueZNw95NdRyuccugjgQv8i7mXNu.JWMpR42ML44FnfjVvnyku8WrEf2R1Ku05vtuURed9AE="

    /// 另造一个签名里同时出现 `+` 和 `/` 的样本，钉住"不做 URL 编码"。
    static let sessionTokenWithPlusAndSlashRaw =
        "Ab3xYz00sessionIdOnly000000000000.a+b/c+d/eFGH1234567890abcdefghijk="

    static let meResponse = Data("""
    {
      "user": {
        "id": "usr_01HZX",
        "email": "founder@example.com",
        "name": "Founder",
        "emailVerified": false,
        "image": null,
        "createdAt": "2026-08-21T10:11:12.000Z"
      }
    }
    """.utf8)

    /// 服务端新增了未在契约里的字段（顶层 + 嵌套 + 未知对象/数组）。解码必须照旧成功。
    static let meResponseWithUnknownFields = Data("""
    {
      "user": {
        "id": "usr_01HZX",
        "email": "founder@example.com",
        "name": "Founder",
        "emailVerified": true,
        "image": "https://cdn.example.com/a.png",
        "createdAt": "2026-08-21T10:11:12.000Z",
        "role": "admin",
        "twoFactorEnabled": false,
        "metadata": { "plan": "pro", "seats": 3 },
        "labels": ["a", "b"]
      },
      "session": { "expiresAt": "2026-09-21T10:11:12.000Z" },
      "serverTime": 1755770000
    }
    """.utf8)

    /// `image` 是 `z.string().url()`，但服务端真给了非 URL 时不能整条解码失败。
    static let meResponseWithUnusableImage = Data("""
    {
      "user": {
        "id": "usr_01HZX",
        "email": "founder@example.com",
        "name": "Founder",
        "emailVerified": false,
        "image": "   ",
        "createdAt": "2026-08-21T10:11:12.000Z"
      }
    }
    """.utf8)

    /// 服务端 200 但资料字段都空 —— 客户端要降级为空态而不是渲染一堆空白。
    static let meResponseWithBlankProfile = Data("""
    {
      "user": {
        "id": "usr_01HZX",
        "email": "   ",
        "name": "",
        "emailVerified": false,
        "image": null,
        "createdAt": "2026-08-21T10:11:12.000Z"
      }
    }
    """.utf8)

    static func apiError(code: String) -> Data {
        Data("""
        { "error": { "code": "\(code)", "message": "not for display", "details": [] } }
        """.utf8)
    }

    /// 自有端点错误 + 服务端新增字段 + `details` 里塞了未知结构。
    static let apiErrorWithUnknownFields = Data("""
    {
      "error": {
        "code": "UNAUTHENTICATED",
        "message": "not for display",
        "details": [{ "path": ["authorization"], "hint": "x" }],
        "traceId": "abc123"
      },
      "requestId": "req_1"
    }
    """.utf8)

    static func betterAuthError(code: String) -> Data {
        Data("""
        { "message": "not for display", "code": "\(code)" }
        """.utf8)
    }

    /// better-auth 的限流响应只有 message，没有 code —— 契约明确说不能假设 code 存在。
    static let betterAuthErrorWithoutCode = Data("""
    { "message": "Too many requests. Please try again later." }
    """.utf8)

    static let notJSON = Data("<html>502 Bad Gateway</html>".utf8)
}
