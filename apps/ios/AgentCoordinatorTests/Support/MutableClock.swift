@testable import AgentCoordinator
import Foundation

/// 可以手动拨动的单调时钟。
///
/// 限流窗口按截止时刻判定，测"窗口到期了没有"必须能让时间往前跳——真的 sleep 十几秒
/// 换来的是慢且不稳的测试（`.claude/rules/testing.md`：时钟属于该被 mock 的外部边界）。
///
/// `advance(by:)` 允许**负数**：生产用的是单调时钟，倒退不该发生，但
/// `RateLimitWindow` 的上限不变式要求"无论时钟怎么动都成立"，所以这里保留把它拨回去的
/// 能力，专门用来钉住那条不变式（`rateLimitWindowNeverOutlivesTheServerCap`）。
final class MutableClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current: ContinuousClock.Instant

    /// 起点取一次就固定住，之后只由 `advance` 移动：断言全部是相对这个起点算的，
    /// 测试结果不随运行时刻变化。
    init(_ start: ContinuousClock.Instant = ContinuousClock.now) {
        current = start
    }

    var now: MonotonicClock {
        { [self] in lock.withLock { current } }
    }

    func advance(by seconds: TimeInterval) {
        lock.withLock { current = current.advanced(by: .seconds(seconds)) }
    }
}
