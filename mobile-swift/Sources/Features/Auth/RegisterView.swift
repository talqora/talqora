import ComposableArchitecture
import SwiftUI

struct RegisterView: View {
    @Bindable var store: StoreOf<RegisterFeature>
    @FocusState private var focus: Field?

    private enum Field { case username, email, password, confirm }

    var body: some View {
        NavigationStack {
            // 表单放 ScrollView(键盘弹出可滚动露出确认密码),按钮贴底 safeAreaInset 自动避让键盘(§1)。
            ScrollView {
                VStack(spacing: 0) {
                    Spacer().frame(height: 24)
                    fields
                    formError
                }
                .padding(.horizontal, WeChatSpacing.xl)
            }
            .scrollDismissesKeyboard(.interactively)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(WeChatColor.elevated.ignoresSafeArea())
            .dismissKeyboardOnTap()
            .safeAreaInset(edge: .bottom) {
                registerButton
                    .padding(.horizontal, WeChatSpacing.xl)
                    .padding(.vertical, 16)
                    .background(WeChatColor.elevated)
            }
            .navigationTitle("注册")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(WeChatColor.navBar, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("取消") { store.send(.cancelTapped) }
                        .foregroundStyle(WeChatColor.textPrimary)
                }
            }
            .onSubmit(advanceFocus)
        }
    }

    private var fields: some View {
        VStack(spacing: 0) {
            fieldRow(label: "用户名", error: store.usernameError) {
                TextField("2-50 位,字母/数字/下划线/中文", text: $store.username)
                    .textContentType(.username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focus, equals: .username)
                    .submitLabel(.next)
            }
            fieldRow(label: "邮箱", error: store.emailError) {
                TextField("you@example.com", text: $store.email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focus, equals: .email)
                    .submitLabel(.next)
            }
            fieldRow(label: "密码", error: store.passwordError) {
                SecureField("含大小写字母与数字,≥6 位", text: $store.password)
                    .textContentType(.newPassword)
                    .focused($focus, equals: .password)
                    .submitLabel(.next)
            }
            fieldRow(label: "确认密码", error: store.confirmError) {
                SecureField("再次输入密码", text: $store.confirmPassword)
                    .textContentType(.newPassword)
                    .focused($focus, equals: .confirm)
                    .submitLabel(.go)
            }
        }
    }

    private func fieldRow<Content: View>(
        label: String,
        error: String?,
        @ViewBuilder field: () -> Content
    ) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: WeChatSpacing.l) {
                Text(label)
                    .font(WeChatFont.body)
                    .foregroundStyle(WeChatColor.textPrimary)
                    .frame(width: 72, alignment: .leading)
                field()
                    .font(WeChatFont.body)
                    .foregroundStyle(WeChatColor.textPrimary)
                    .tint(WeChatColor.brand)
            }
            .padding(.vertical, 15)

            if let error {
                Text(LocalizedStringKey(error))
                    .font(WeChatFont.caption)
                    .foregroundStyle(WeChatColor.badge)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.bottom, 6)
            }

            Rectangle().fill(WeChatColor.separator).frame(height: 0.5)
        }
    }

    @ViewBuilder private var formError: some View {
        if let message = store.formError {
            Text(LocalizedStringKey(message))
                .font(WeChatFont.footnote)
                .foregroundStyle(WeChatColor.badge)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, WeChatSpacing.m)
        }
    }

    private var registerButton: some View {
        Button { store.send(.registerButtonTapped) } label: {
            Group {
                if store.isLoading {
                    ProgressView().tint(.white)
                } else {
                    Text("注册").font(.system(size: 17, weight: .medium))
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 48)
            .background(WeChatColor.brand.opacity(store.isLoading ? 0.4 : 1))
            .foregroundStyle(.white)
            .clipShape(RoundedRectangle(cornerRadius: WeChatRadius.m, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .disabled(store.isLoading)
    }

    private func advanceFocus() {
        switch focus {
        case .username: focus = .email
        case .email: focus = .password
        case .password: focus = .confirm
        case .confirm, .none: store.send(.registerButtonTapped)
        }
    }
}

#Preview {
    RegisterView(
        store: Store(initialState: RegisterFeature.State()) {
            RegisterFeature()
        }
    )
}
