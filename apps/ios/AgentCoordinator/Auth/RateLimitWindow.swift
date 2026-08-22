import Foundation

/// 限流窗口的剩余时间。
///
/// **唯一的计算入口**：表单、会话状态、倒计时视图都从这里读。窗口有一条不变式——
/// 剩余量永远不超过 `AuthFailureClassifier.maxRetryAfterSeconds`——把它放在一处计算，
/// 这条不变式就在**每个读点**都成立，而不是只在写入时钳一次。
enum RateLimitWindow {
    /// 距离窗口截止还有几秒；窗口已经过去、或窗口本身不可信时返回 nil（= 不再封锁）。
    ///
    /// 两道判定：
    ///   1. 截止时刻已过 → nil，正常到期；
    ///   2. 剩余量超过服务端上限 → nil。上限在 `AuthFailureClassifier` 写入时已经钳过一次
    ///      （服务端给出荒谬的 Retry-After 时不把用户锁进几小时的倒计时），这里是把它抬成
    ///      **始终成立**的不变式：单调时钟不会倒退，所以生产环境走不到这一格；真走到了
    ///      只说明时钟不可信，那就不能拿一个不可信的窗口继续封锁用户——这里放行最坏也只是
    ///      多发一次注定 429 的请求，服务端的限流仍然兜着；反过来把用户锁死则只有杀进程
    ///      才出得来（`AuthFormModel` 由 `AuthFormScreen` 的 `@State` 持有，登录页不重建）。
    static func secondsRemaining(
        until deadline: ContinuousClock.Instant,
        now: ContinuousClock.Instant
    ) -> Int? {
        let remaining = now.duration(to: deadline)
        guard remaining > .zero else { return nil }
        guard remaining <= .seconds(AuthFailureClassifier.maxRetryAfterSeconds) else { return nil }

        // 向上取整到秒：还剩 0.2 秒时显示 1 而不是 0，倒计时不会提前归零。
        // 走 Duration 的整数分量而不是转 Double，避免长窗口上的浮点误差。
        let parts = remaining.components
        return Int(parts.seconds) + (parts.attoseconds > 0 ? 1 : 0)
    }
}
