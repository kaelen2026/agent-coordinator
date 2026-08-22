@testable import AgentCoordinator
import Foundation

/// 可以手动拨动的墙钟。
///
/// 限流窗口按截止时刻判定，测"窗口到期了没有"必须能让时间往前跳——真的 sleep 十几秒
/// 换来的是慢且不稳的测试（`.claude/rules/testing.md`：时钟属于该被 mock 的外部边界）。
final class MutableClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date

    /// 固定起点，不取 `Date()`：测试结果不该随运行时刻变化。
    init(_ start: Date = Date(timeIntervalSince1970: 1_770_000_000)) {
        current = start
    }

    var now: DateProvider {
        { [self] in lock.withLock { current } }
    }

    func advance(by seconds: TimeInterval) {
        lock.withLock { current += seconds }
    }
}
