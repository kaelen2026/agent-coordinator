import SwiftUI

/// 登录 / 注册共用一个表单壳子：两者的差别只有"多一个姓名字段"和密码规则，
/// 分成两个几乎一样的 View 只会让文案和状态处理各写两遍。
struct AuthFormScreen: View {
    @State private var form: AuthFormModel

    /// 切到另一种模式（登录页 → 注册页）。注册页没有下一跳，所以是可选的。
    private let onSwitchMode: (() -> Void)?

    init(
        mode: AuthFormModel.Mode,
        authenticator: any AuthenticationPerforming,
        onSwitchMode: (() -> Void)? = nil
    ) {
        _form = State(initialValue: AuthFormModel(mode: mode, authenticator: authenticator))
        self.onSwitchMode = onSwitchMode
    }

    var body: some View {
        Form {
            Section {
                if form.mode == .signUp {
                    AuthField(
                        title: AuthCopy.nameField,
                        text: $form.name,
                        error: form.fieldErrors[.name],
                        contentType: .name
                    )
                }

                AuthField(
                    title: AuthCopy.emailField,
                    text: $form.email,
                    error: form.fieldErrors[.email],
                    contentType: .emailAddress,
                    keyboard: .emailAddress
                )

                AuthField(
                    title: AuthCopy.passwordField,
                    text: $form.password,
                    error: form.fieldErrors[.password],
                    contentType: form.mode == .signUp ? .newPassword : .password,
                    isSecure: true
                )
            } footer: {
                if form.mode == .signUp {
                    Text(AuthCopy.passwordRule)
                }
            }

            // 用截止时刻而不是剩余秒数驱动：秒数每跳一次都会变，拿它当 .task(id:)
            // 会把倒计时每秒重启一遍；截止时刻在一个窗口内是常量。
            if let deadline = form.rateLimitedUntil {
                Section {
                    RateLimitNoticeView(deadline: deadline) {
                        form.clearRateLimit()
                    }
                    .font(.footnote)
                    .foregroundStyle(.red)
                }
            } else if let message = form.failureMessage {
                Section {
                    Label(message, systemImage: "exclamationmark.circle")
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .accessibilityAddTraits(.isStaticText)
                }
            }

            Section {
                Button {
                    Task { await form.submit() }
                } label: {
                    HStack {
                        Spacer()
                        if form.isSubmitting {
                            ProgressView()
                        } else {
                            Text(submitTitle)
                        }
                        Spacer()
                    }
                }
                // 限流期间也禁用：再点只会继续吃 429（web 基线同一条规则）。
                .disabled(form.isSubmitBlocked)

                if let onSwitchMode {
                    Button(AuthCopy.goToSignUp, action: onSwitchMode)
                        .disabled(form.isSubmitting)
                }
            }
        }
        // 改动输入就把上一次的失败提示收掉，别让旧错误挂在新输入上
        .onChange(of: form.email) { form.clearFailure() }
        .onChange(of: form.password) { form.clearFailure() }
        .onChange(of: form.name) { form.clearFailure() }
    }

    private var submitTitle: String {
        form.mode == .signUp ? AuthCopy.signUpTitle : AuthCopy.signInTitle
    }
}

/// 一个带标题、错误提示的输入行。样式收在这里，不在每个字段旁边复制修饰符链。
private struct AuthField: View {
    let title: String
    @Binding var text: String
    let error: String?
    let contentType: UITextContentType
    var keyboard: UIKeyboardType = .default
    var isSecure = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if isSecure {
                SecureField(title, text: $text)
                    .textContentType(contentType)
            } else {
                TextField(title, text: $text)
                    .textContentType(contentType)
                    .keyboardType(keyboard)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }

            if let error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .accessibilityLabel(title)
        .accessibilityValue(error ?? "")
    }
}
