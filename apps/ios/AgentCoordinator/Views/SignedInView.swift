import SwiftUI

/// 已登录后的界面。`showsProfile == false` 就是"服务端 200 但资料为空"的空态 ——
/// 空态仍然在已登录壳子里，用户照样能登出。
struct SignedInView: View {
    let session: SessionController
    let user: AuthUser
    let showsProfile: Bool

    var body: some View {
        NavigationStack {
            List {
                if showsProfile {
                    Section(AuthCopy.profileSection) {
                        LabeledContent(AuthCopy.nameField, value: displayValue(user.name))
                        LabeledContent(AuthCopy.emailField, value: displayValue(user.email))
                        LabeledContent(
                            AuthCopy.emailVerifiedField,
                            value: user.emailVerified ? AuthCopy.yes : AuthCopy.no
                        )
                    }
                } else {
                    Section {
                        ContentUnavailableView(
                            AuthCopy.emptyProfileTitle,
                            systemImage: "person.crop.circle.badge.questionmark",
                            description: Text(AuthCopy.emptyProfileDescription)
                        )
                    }
                }

                if let failure = session.signOutFailure {
                    Section {
                        if let deadline = session.signOutRateLimitDeadline {
                            RateLimitNoticeView(deadline: deadline)
                                .font(.footnote)
                                .foregroundStyle(.red)
                        } else {
                            Label(AuthCopy.message(for: failure), systemImage: "exclamationmark.circle")
                                .font(.footnote)
                                .foregroundStyle(.red)
                        }
                    }
                }

                Section {
                    Button(role: .destructive) {
                        Task { await session.signOut() }
                    } label: {
                        HStack {
                            Spacer()
                            Text(session.isSigningOut ? AuthCopy.signingOut : AuthCopy.signOut)
                            Spacer()
                        }
                    }
                    .disabled(session.isSigningOut)
                }
            }
            .navigationTitle(AuthCopy.signedInTitle)
            // 登出进行中的下拉刷新会被 SessionController 挡下（结果注定要丢）。
            // 状态层自己防住竞态，这里只是省掉一次无意义的下拉动作。
            .refreshable { await session.refresh() }
        }
    }

    /// 服务端给了空值时展示占位，而不是渲染一行空白。
    private func displayValue(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? AuthCopy.missingValuePlaceholder : trimmed
    }
}

#if DEBUG
    #Preview("已登录") {
        SignedInView(
            session: PreviewSupport.session(.loaded(PreviewSupport.user)),
            user: PreviewSupport.user,
            showsProfile: true
        )
    }

    #Preview("空资料") {
        SignedInView(
            session: PreviewSupport.session(.empty(PreviewSupport.blankUser)),
            user: PreviewSupport.blankUser,
            showsProfile: false
        )
    }
#endif
