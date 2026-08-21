/// 会话 token。
///
/// 契约（`packages/contracts/src/index.ts`「原生客户端的 bearer token 认证」第 2 节）要求
/// **原样透传**：形状是 `<会话 id>.<标准 base64 HMAC 签名>`，签名里会出现 `+` `/` 和末尾 `=`。
/// 服务端开了 `requireSignature`，任何加工（URL 编解码、trim、按 `.` 截断只留会话 id）都会让
/// 凭证变成无效值（401）。所以这个类型只做两件事：存原始字符串、拼 `Authorization` 头。
///
/// 刻意不校验形状（比如"必须含一个点"）：token 格式由服务端定义，客户端加一道自己的格式
/// 判断，等于给未来的服务端升级埋一颗不可热修的雷。
struct SessionToken: Equatable, Sendable {
    let rawValue: String

    /// 只拒绝空值：全空白的头等于没下发 token，不是一个可用凭证。
    /// 注意判空用的是 trim 后的结果，但**存下来的是原值**——不 trim 内容本身。
    init?(rawValue: String) {
        guard !rawValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        self.rawValue = rawValue
    }

    var authorizationHeaderValue: String {
        "Bearer \(rawValue)"
    }
}

extension SessionToken: CustomStringConvertible, CustomDebugStringConvertible {
    /// 防止 token 顺着字符串插值进日志（`.claude/rules/swift.md`：日志禁止打印敏感信息）。
    var description: String {
        "SessionToken(redacted)"
    }

    var debugDescription: String {
        "SessionToken(redacted)"
    }
}
