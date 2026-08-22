import Foundation

/// 墙钟时间的来源。
///
/// 限流窗口按**截止时刻**判定，而"现在几点"是个外部边界：测试要能把时间拨快 30 秒，
/// 而不是真的等 30 秒（`.claude/rules/testing.md`：时钟属于该被 mock 的边界）。
/// 所以凡是要读当前时间的 ViewModel 都从初始化器接这个闭包，不在方法里直接 `Date()`。
///
/// 只有一个生产实现（系统时钟），故用闭包而不是 protocol
/// （`architecture.md`：不为"将来可能"引入抽象）。
typealias DateProvider = @Sendable () -> Date

/// 系统时钟。默认参数用它，测试传自己的。
let systemDateProvider: DateProvider = { Date() }
