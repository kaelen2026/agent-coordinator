import SwiftUI

/// 加载中。
struct LoadingStateView: View {
    let message: String

    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text(message)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
        .accessibilityElement(children: .combine)
    }
}

/// 离线。与"服务端出错"分开：文案指向网络，且给重试入口。
struct OfflineStateView: View {
    let onRetry: () async -> Void

    var body: some View {
        ContentUnavailableView {
            Label(AuthCopy.offlineTitle, systemImage: "wifi.slash")
        } description: {
            Text(AuthCopy.offlineDescription)
        } actions: {
            AsyncButton(AuthCopy.retry, action: onRetry)
                .buttonStyle(.borderedProminent)
        }
    }
}

/// 可重试的错误态。限流时用倒计时展示还要等多久（窗口截止时刻由 `SessionController` 持有）。
struct FailureStateView: View {
    let failure: AuthFailure
    /// 限流失败才有值。
    let rateLimitDeadline: Date?
    let onRetry: () async -> Void

    var body: some View {
        ContentUnavailableView {
            Label(AuthCopy.errorTitle, systemImage: "exclamationmark.triangle")
        } description: {
            if let rateLimitDeadline {
                RateLimitNoticeView(deadline: rateLimitDeadline)
            } else {
                Text(AuthCopy.message(for: failure))
            }
        } actions: {
            AsyncButton(AuthCopy.retry, action: onRetry)
                .buttonStyle(.borderedProminent)
        }
    }
}

/// 配置缺失：不是用户能修的问题，如实说明而不是伪装成网络错误。
struct ConfigurationErrorView: View {
    let error: AppConfigurationError

    var body: some View {
        ContentUnavailableView {
            Label(AuthCopy.misconfiguredTitle, systemImage: "gearshape.badge.xmark")
        } description: {
            Text(AuthCopy.misconfiguredDescription(for: error))
        }
    }
}

/// 限流倒计时。
///
/// 参数是窗口的**截止时刻**而不是剩余秒数：`.task` 在离屏 / 切后台时会被取消，回来是重启
/// 不是续跑，拿秒数当起点就会从头再数一遍。每跳一次都拿墙钟对着截止时刻重算，
/// 于是重启也只是接着数剩下的。截止时刻由状态的归属者持有（`AuthFormModel` /
/// `SessionController`），视图自己不发明时间。
struct RateLimitNoticeView: View {
    let deadline: Date
    var onExpire: (() -> Void)?

    @State private var remaining = 0

    var body: some View {
        Text(AuthCopy.rateLimitMessage(secondsRemaining: remaining))
            // .task(id:) 让换了一个窗口时自动重启，视图消失时自动取消
            .task(id: deadline) {
                while true {
                    remaining = Self.secondsRemaining(until: deadline)
                    if remaining <= 0 {
                        break
                    }
                    do {
                        try await Task.sleep(for: .seconds(1))
                    } catch {
                        return // 被取消
                    }
                }
                onExpire?()
            }
    }

    private static func secondsRemaining(until deadline: Date) -> Int {
        let remaining = deadline.timeIntervalSince(Date())
        return remaining > 0 ? Int(remaining.rounded(.up)) : 0
    }
}

/// 带进行中状态的异步按钮：把"点一下 → 跑一个 async 动作 → 期间禁用"收在一处，
/// 免得每个调用点各写一遍 Task + 布尔标志。
struct AsyncButton: View {
    private let title: String
    private let action: () async -> Void

    @State private var isRunning = false

    init(_ title: String, action: @escaping () async -> Void) {
        self.title = title
        self.action = action
    }

    var body: some View {
        Button {
            guard !isRunning else { return }
            Task {
                isRunning = true
                await action()
                isRunning = false
            }
        } label: {
            if isRunning {
                ProgressView()
            } else {
                Text(title)
            }
        }
        .disabled(isRunning)
    }
}

#if DEBUG
    #Preview("加载中") {
        LoadingStateView(message: AuthCopy.checkingSession)
    }

    #Preview("离线") {
        OfflineStateView {}
    }

    #Preview("错误：服务端 5xx") {
        FailureStateView(failure: .server(status: 503), rateLimitDeadline: nil) {}
    }

    #Preview("错误：限流倒计时") {
        FailureStateView(
            failure: .rateLimited(retryAfterSeconds: 45),
            rateLimitDeadline: Date().addingTimeInterval(45)
        ) {}
    }

    #Preview("配置缺失：没传地址") {
        ConfigurationErrorView(error: .missingBaseURL)
    }

    #Preview("配置缺失：地址不合法") {
        ConfigurationErrorView(error: .malformedBaseURL("not a url"))
    }
#endif
