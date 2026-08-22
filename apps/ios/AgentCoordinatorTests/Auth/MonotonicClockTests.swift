@testable import AgentCoordinator
import Foundation
import Testing

/// 限流窗口选 `ContinuousClock` 而不是 `Date` / `SuspendingClock` 的依据。
///
/// **实测记录**（Xcode 26.6 / 17F113，iOS Simulator 26.5，iPhone 17 Pro）：
///
/// ```
/// mach_timebase numer=125 denom=3
/// mach_absolute_time   = 2722765.2198 s
/// mach_continuous_time = 3464174.3478 s      ← 差 741409 s（≈8.6 天）= 开机以来的休眠时长
/// ContinuousClock.now  = Instant(_value: 3464174.347776 seconds)   ← 等于 mach_continuous_time
/// SuspendingClock.now  = Instant(_value: 2722765.22325075 seconds) ← 等于 mach_absolute_time
/// 真实 sleep 300ms：Continuous=0.3076s  Suspending=0.3076s  Date=0.3076s
/// ```
///
/// 结论（回答"设备休眠时照不照走"）：`ContinuousClock` 就是 `mach_continuous_time`，
/// 而这台机器上它比 `mach_absolute_time` **多出 8.6 天**——那正是累计休眠时长，说明
/// 休眠期间它一直在走。`SuspendingClock` 则等于 `mach_absolute_time`，休眠时会停，
/// 用它会把限流窗口拖长，所以不能用。两者都与 `Date`（墙钟）无关，用户改设备时间不影响它们。
///
/// 下面留成常驻测试的只有"跟真实流逝的时间一致"这一条：其余结论由类型系统守着——
/// `MonotonicClock` 的签名是 `() -> ContinuousClock.Instant`，换回 `Date` 或换成
/// `SuspendingClock` 都编译不过。
@Suite("单调时钟：限流窗口的时间基准")
struct MonotonicClockTests {
    @Test("systemMonotonicClock 跟着真实时间走，且只增不减")
    func systemClockTracksRealElapsedTime() async throws {
        let start = systemMonotonicClock()
        try await Task.sleep(for: .milliseconds(200))
        let end = systemMonotonicClock()

        let elapsed = start.duration(to: end)
        #expect(elapsed > .zero)
        // 下界卡紧（真的等了 200ms），上界给足调度余量，避免机器忙时抖成 flaky。
        #expect(elapsed >= .milliseconds(190))
        #expect(elapsed < .seconds(5))
    }

    @Test("窗口剩余量：到期、未到期、超出服务端上限三种读法")
    func windowRemainingCoversItsThreeBranches() {
        let base = ContinuousClock.now

        // 未到期：向上取整
        #expect(RateLimitWindow.secondsRemaining(
            until: base.advanced(by: .milliseconds(6500)), now: base
        ) == 7)

        // 正好到期与已经过期都算窗口已过
        #expect(RateLimitWindow.secondsRemaining(until: base, now: base) == nil)
        #expect(RateLimitWindow.secondsRemaining(
            until: base.advanced(by: .seconds(-1)), now: base
        ) == nil)

        // 上限边界：正好等于上限仍然成立
        let cap = AuthFailureClassifier.maxRetryAfterSeconds
        #expect(RateLimitWindow.secondsRemaining(
            until: base.advanced(by: .seconds(cap)), now: base
        ) == cap)

        // 超过上限：窗口不可信，不拿它继续封锁用户
        #expect(RateLimitWindow.secondsRemaining(
            until: base.advanced(by: .seconds(cap + 1)), now: base
        ) == nil)
    }
}
