import ComposableArchitecture
import Services
import Core
import Foundation

@Reducer
public struct RegisterFeature {
    public init() {}

    @ObservableState
    public struct State: Equatable {
        public init(
            username: String = "",
            email: String = "",
            password: String = "",
            confirmPassword: String = "",
            isLoading: Bool = false,
            usernameError: String? = nil,
            emailError: String? = nil,
            passwordError: String? = nil,
            confirmError: String? = nil,
            formError: String? = nil
        ) {
            self.username = username
            self.email = email
            self.password = password
            self.confirmPassword = confirmPassword
            self.isLoading = isLoading
            self.usernameError = usernameError
            self.emailError = emailError
            self.passwordError = passwordError
            self.confirmError = confirmError
            self.formError = formError
        }
        var username = ""
        var email = ""
        var password = ""
        var confirmPassword = ""
        var isLoading = false
        // 分字段错误(对齐 web 的 FieldErr)。
        var usernameError: String?
        var emailError: String?
        var passwordError: String?
        var confirmError: String?
        var formError: String? // 注册接口本身失败的通用提示
    }

    public enum Action: BindableAction, Equatable {
        case binding(BindingAction<State>)
        case registerButtonTapped
        case cancelTapped
        case uniquenessChecked(usernameTaken: Bool, emailTaken: Bool)
        case registerSucceeded
        case registerFailed(String)
        case delegate(Delegate)

        public enum Delegate: Equatable {
            // 注册成功:通知登录页预填用户名并关闭。
            case registered(username: String)
        }
    }

    @Dependency(\.authService) var authService
    @Dependency(\.dismiss) var dismiss

    public var body: some ReducerOf<Self> {
        BindingReducer()
        Reduce { state, action in
            switch action {
            case .binding:
                // 编辑即清旧错误,下次提交重新校验。
                state.usernameError = nil
                state.emailError = nil
                state.passwordError = nil
                state.confirmError = nil
                state.formError = nil
                return .none

            case .registerButtonTapped:
                // ① 本地校验(与 web validateLocal 一致的正则规则)。
                let errors = validateLocal(state)
                state.usernameError = errors.username
                state.emailError = errors.email
                state.passwordError = errors.password
                state.confirmError = errors.confirm
                state.formError = nil
                guard errors.isEmpty else { return .none }

                // ② 远端唯一性预检:并行,失败按未占用处理(对齐 web .catch(() => false))。
                state.isLoading = true
                let username = state.username
                let email = state.email
                return .run { [authService] send in
                    async let usernameTaken = (try? await authService.checkUsername(username)) ?? false
                    async let emailTaken = (try? await authService.checkEmail(email)) ?? false
                    let (uTaken, eTaken) = await (usernameTaken, emailTaken)
                    await send(.uniquenessChecked(usernameTaken: uTaken, emailTaken: eTaken))
                }

            case let .uniquenessChecked(usernameTaken, emailTaken):
                if usernameTaken || emailTaken {
                    state.isLoading = false
                    state.usernameError = usernameTaken ? "用户名已存在" : nil
                    state.emailError = emailTaken ? "邮箱已被注册" : nil
                    return .none
                }
                // ③ 通过 → 真正注册。
                let username = state.username
                let email = state.email
                let password = state.password
                return .run { [authService] send in
                    do {
                        try await authService.register(username, email, password)
                        await send(.registerSucceeded)
                    } catch {
                        await send(.registerFailed(registerFailureMessage(error)))
                    }
                }

            case .cancelTapped:
                return .run { [dismiss] _ in await dismiss() }

            case .registerSucceeded:
                state.isLoading = false
                return .send(.delegate(.registered(username: state.username)))

            case let .registerFailed(message):
                state.isLoading = false
                state.formError = message
                return .none

            case .delegate:
                return .none
            }
        }
    }
}

// 分字段本地校验结果。
private struct FieldErrors: Equatable {
    var username: String?
    var email: String?
    var password: String?
    var confirm: String?
    var isEmpty: Bool { username == nil && email == nil && password == nil && confirm == nil }
}

// 与 web registerForm 的 usernameRule/emailRule/passwordRule + 长度规则一致。
private func validateLocal(_ state: RegisterFeature.State) -> FieldErrors {
    var errors = FieldErrors()

    if state.username.isEmpty {
        errors.username = "请输入用户名"
    } else if state.username.count < 2 {
        errors.username = "用户名至少 2 个字符"
    } else if !matches(state.username, "^[a-zA-Z0-9_一-龥]+$") {
        errors.username = "仅允许字母 / 数字 / 下划线 / 中文"
    }

    if state.email.isEmpty {
        errors.email = "请输入邮箱"
    } else if !matches(state.email, "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$") {
        errors.email = "邮箱格式不对"
    }

    if state.password.isEmpty {
        errors.password = "请输入密码"
    } else if !matches(state.password, "^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)[a-zA-Z\\d@$!%*?&]{6,}$") {
        errors.password = "需含大小写字母与数字,长度 ≥ 6"
    }

    if state.confirmPassword.isEmpty {
        errors.confirm = "请再输一遍密码"
    } else if state.confirmPassword != state.password {
        errors.confirm = "两次密码不一致"
    }

    return errors
}

private func matches(_ value: String, _ pattern: String) -> Bool {
    value.range(of: pattern, options: .regularExpression) != nil
}

private func registerFailureMessage(_ error: Error) -> String {
    if case let APIError.server(message) = error { return message }
    return "注册失败,请稍后重试"
}
