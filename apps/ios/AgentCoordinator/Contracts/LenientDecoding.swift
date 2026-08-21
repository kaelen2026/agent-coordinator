import Foundation

extension KeyedDecodingContainer {
    /// 宽容解码：键缺失、值为 null、或值的类型和预期不一致时退到默认值，
    /// 而不是让整条响应解码失败。
    ///
    /// `.claude/rules/swift.md`：客户端不可热修，"服务端多给/少给/给错一个字段"不能让功能
    /// 整体不可用。识别身份的关键字段（如 `user.id`）仍然严格要求 —— 缺了它这条数据本身
    /// 没有意义，降级成占位反而会把一个损坏的会话伪装成正常会话。
    ///
    /// `try?` 会把 `T??` 拍平成 `T?`，于是"缺失"、"null"、"类型不对"三种情况统一走默认值，
    /// 这正是想要的语义。
    func lenient<T: Decodable>(_ type: T.Type, forKey key: Key, default fallback: T) -> T {
        (try? decodeIfPresent(type, forKey: key)) ?? fallback
    }

    func lenientIfPresent<T: Decodable>(_ type: T.Type, forKey key: Key) -> T? {
        try? decodeIfPresent(type, forKey: key)
    }
}
