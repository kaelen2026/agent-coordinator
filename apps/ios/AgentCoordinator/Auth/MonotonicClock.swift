import Foundation

/// 限流窗口用的时钟读数。
///
/// 刻意用 `ContinuousClock`（单调时钟）而**不是** `Date`（墙钟）。窗口要回答的是
/// "还要等多久"——一个**时长**问题；用截止**时刻**表达它，就把答案的正确性绑在了
/// "现在几点"上，而"现在几点"是用户能改的：设置里改时间、NTP 步进校正、夏令时回拨
/// 都会让墙钟往回跳，于是一个 60 秒的窗口能变成一天。客户端不可热修，这类 bug 只能靠
/// 一开始就选对时钟来避免。
///
/// `ContinuousClock` 正好是这个场景要的两条性质：
///   - 与墙钟解耦，用户改时间它不动；
///   - **挂起/休眠期间照走**（Darwin 上是 `mach_continuous_time`），所以"切后台 5 分钟
///     回来窗口已经过去了"这件事自然成立——这正是当初选截止时刻而不是倒计时的原因。
///     （对照：`SuspendingClock` 在设备睡眠时会停，用它会把窗口拖长，不能用。）
///
/// 只有一个生产实现，故用闭包而不是 protocol（`architecture.md`：不为"将来可能"引入抽象）；
/// 经初始化器注入是为了让测试能把时间拨快，而不是真的等（`.claude/rules/testing.md`：
/// 时钟属于该被 mock 的外部边界）。
typealias MonotonicClock = @Sendable () -> ContinuousClock.Instant

/// 系统单调时钟。默认参数用它，测试传自己的。
let systemMonotonicClock: MonotonicClock = { ContinuousClock.now }
