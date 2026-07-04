import ComposableArchitecture
import SwiftUI

struct LoginView: View {
    @Bindable var store: StoreOf<AuthFeature>
    @State private var isPasswordVisible = false
    @FocusState private var focus: Field?

    private enum Field { case username, password }

    var body: some View {
        VStack(spacing: 0) {
            Text("登录")
                .font(WeChatFont.navTitle)
                .foregroundStyle(WeChatColor.textPrimary)
                .frame(maxWidth: .infinity)
                .padding(.top, WeChatSpacing.m)

            Spacer().frame(height: 48)
            identity
            Spacer().frame(height: 44)
            fields
            errorLabel
            Spacer()
            loginButton
            Spacer().frame(height: 16)
            Button("注册账号") { store.send(.registerTapped) }
                .font(WeChatFont.callout)
                .foregroundStyle(WeChatColor.brand)
                .buttonStyle(PressableButtonStyle())
            Spacer().frame(height: 20)
            footer
            Spacer().frame(height: 20)
        }
        .padding(.horizontal, WeChatSpacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(WeChatColor.elevated.ignoresSafeArea())
        .dismissKeyboardOnTap()
        .sheet(item: $store.scope(state: \.register, action: \.register)) { registerStore in
            RegisterView(store: registerStore)
        }
        .onSubmit {
            if focus == .username {
                focus = .password
            } else if store.isLoginEnabled {
                store.send(.loginButtonTapped)
            }
        }
    }

    // 头像 + 账号标识(对应微信登录页的「头像 + 手机号」区):账号即大号居中输入
    private var identity: some View {
        VStack(spacing: WeChatSpacing.l) {
            IconTile(
                systemName: "bubble.left.and.bubble.right.fill",
                color: WeChatColor.brand,
                size: 72,
                cornerRadius: 16
            )
            TextField("用户名", text: $store.username)
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(WeChatColor.textPrimary)
                .tint(WeChatColor.brand)
                .multilineTextAlignment(.center)
                .textContentType(.username)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focus, equals: .username)
                .submitLabel(.next)
        }
    }

    // 密码行:左标签 + 输入 + 右侧眼睛切换(对应微信「验证码 … 获取验证码」的行结构)
    private var fields: some View {
        VStack(spacing: 0) {
            separator
            HStack(spacing: WeChatSpacing.l) {
                Text("密码")
                    .font(WeChatFont.body)
                    .foregroundStyle(WeChatColor.textPrimary)
                    .frame(width: 56, alignment: .leading)

                Group {
                    if isPasswordVisible {
                        TextField("请输入密码", text: $store.password)
                    } else {
                        SecureField("请输入密码", text: $store.password)
                    }
                }
                .font(WeChatFont.body)
                .foregroundStyle(WeChatColor.textPrimary)
                .tint(WeChatColor.brand)
                .textContentType(.password)
                .focused($focus, equals: .password)
                .submitLabel(.go)

                Button {
                    isPasswordVisible.toggle()
                } label: {
                    Image(systemName: isPasswordVisible ? "eye" : "eye.slash")
                        .font(.system(size: 17))
                        .foregroundStyle(WeChatColor.textTertiary)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isPasswordVisible ? "隐藏密码" : "显示密码")
            }
            .padding(.vertical, 15)
            separator
        }
    }

    private var separator: some View {
        Rectangle()
            .fill(WeChatColor.separator)
            .frame(height: 0.5)
    }

    @ViewBuilder
    private var errorLabel: some View {
        if let message = store.errorMessage {
            Text(LocalizedStringKey(message))
                .font(WeChatFont.footnote)
                .foregroundStyle(WeChatColor.badge)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, WeChatSpacing.m)
        }
    }

    // 底部链接:仅还原微信视觉,占位无业务逻辑(对应「找回密码 | 冻结账号 | 更多」)
    private var footer: some View {
        HStack(spacing: WeChatSpacing.m) {
            footerLink("找回密码")
            footerDivider
            footerLink("冻结账号")
            footerDivider
            footerLink("更多")
        }
    }

    private func footerLink(_ title: String) -> some View {
        Button {} label: {
            Text(title)
                .font(WeChatFont.footnote)
                .foregroundStyle(WeChatColor.textSecondary)
        }
        .buttonStyle(.plain)
    }

    private var footerDivider: some View {
        Rectangle()
            .fill(WeChatColor.separator)
            .frame(width: 0.5, height: 12)
    }

    private var loginButton: some View {
        Button {
            store.send(.loginButtonTapped)
        } label: {
            Group {
                if store.isLoading {
                    ProgressView().tint(.white)
                } else {
                    Text("登录").font(.system(size: 17, weight: .medium))
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 48)
            .background(WeChatColor.brand.opacity(store.isLoginEnabled ? 1 : 0.4))
            .foregroundStyle(.white)
            .clipShape(RoundedRectangle(cornerRadius: WeChatRadius.m, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .disabled(!store.isLoginEnabled)
    }
}

#Preview {
    LoginView(
        store: Store(initialState: AuthFeature.State()) {
            AuthFeature()
        }
    )
}
