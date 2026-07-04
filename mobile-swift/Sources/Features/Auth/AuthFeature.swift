import ComposableArchitecture
import Foundation

@Reducer
struct AuthFeature {
    @ObservableState
    struct State: Equatable {
        var username = ""
        var password = ""
        var isLoading = false
        var errorMessage: String?
        @Presents var register: RegisterFeature.State?

        var isLoginEnabled: Bool {
            !username.isEmpty && !password.isEmpty && !isLoading
        }
    }

    enum Action: BindableAction, Equatable {
        case binding(BindingAction<State>)
        case loginButtonTapped
        case loginSucceeded(AuthTokens)
        case loginFailed(message: String)
        case registerTapped
        case register(PresentationAction<RegisterFeature.Action>)
        case delegate(Delegate)

        enum Delegate: Equatable {
            case loggedIn(AuthTokens)
        }
    }

    @Dependency(\.authService) var authService

    var body: some ReducerOf<Self> {
        BindingReducer()
        Reduce { state, action in
            switch action {
            case .binding:
                state.errorMessage = nil
                return .none

            case .loginButtonTapped:
                guard state.isLoginEnabled else { return .none }
                state.isLoading = true
                state.errorMessage = nil
                let username = state.username
                let password = state.password
                return .run { send in
                    do {
                        let tokens = try await authService.login(
                            username: username,
                            password: password,
                            remember: true
                        )
                        await send(.loginSucceeded(tokens))
                    } catch {
                        await send(.loginFailed(message: loginErrorMessage(error)))
                    }
                }

            case let .loginSucceeded(tokens):
                state.isLoading = false
                return .send(.delegate(.loggedIn(tokens)))

            case let .loginFailed(message):
                state.isLoading = false
                state.errorMessage = message
                return .none

            case .registerTapped:
                state.register = RegisterFeature.State()
                return .none

            case let .register(.presented(.delegate(.registered(username)))):
                // 注册成功:回登录页预填用户名、清密码,关闭注册。
                state.username = username
                state.password = ""
                state.register = nil
                return .none

            case .register, .delegate:
                return .none
            }
        }
        .ifLet(\.$register, action: \.register) {
            RegisterFeature()
        }
    }
}

private func loginErrorMessage(_ error: Error) -> String {
    if let apiError = error as? APIError {
        switch apiError {
        case .unauthorized:
            return "用户名或密码错误"
        case let .http(status, _) where status == 400:
            // 服务端对用户不存在/密码错误统一返回 400
            return "用户名或密码错误"
        case let .server(message):
            return message
        default:
            break
        }
    }
    return "登录失败,请稍后重试"
}
