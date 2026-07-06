import ComposableArchitecture
@testable import Auth
import Services
import Core
import Foundation
import Testing

@MainActor
struct RegisterFeatureTests {
    @Test
    func successChecksUniquenessThenRegistersAndEmitsDelegate() async {
        let store = TestStore(initialState: RegisterFeature.State(
            username: "neo", email: "neo@x.com", password: "Secret1", confirmPassword: "Secret1"
        )) {
            RegisterFeature()
        } withDependencies: {
            $0.authService.checkUsername = { _ in false }
            $0.authService.checkEmail = { _ in false }
            $0.authService.register = { _, _, _ in }
        }
        await store.send(.registerButtonTapped) { $0.isLoading = true }
        await store.receive(\.uniquenessChecked) // (false, false) → 继续注册
        await store.receive(\.registerSucceeded) { $0.isLoading = false }
        await store.receive(\.delegate)
    }

    @Test
    func usernameTakenShowsFieldError() async {
        let store = TestStore(initialState: RegisterFeature.State(
            username: "neo", email: "neo@x.com", password: "Secret1", confirmPassword: "Secret1"
        )) {
            RegisterFeature()
        } withDependencies: {
            $0.authService.checkUsername = { _ in true }
            $0.authService.checkEmail = { _ in false }
        }
        await store.send(.registerButtonTapped) { $0.isLoading = true }
        await store.receive(\.uniquenessChecked) {
            $0.isLoading = false
            $0.usernameError = "用户名已存在"
        }
    }

    @Test
    func localValidationSetsPerFieldErrors() async {
        let store = TestStore(initialState: RegisterFeature.State(
            username: "a", email: "bad", password: "12345", confirmPassword: "67890"
        )) {
            RegisterFeature()
        }
        // 本地校验不通过 → 分字段错误,不触网、不进 loading。
        await store.send(.registerButtonTapped) {
            $0.usernameError = "用户名至少 2 个字符"
            $0.emailError = "邮箱格式不对"
            $0.passwordError = "需含大小写字母与数字,长度 ≥ 6"
            $0.confirmError = "两次密码不一致"
        }
    }

    @Test
    func registerFailureShowsFormError() async {
        let store = TestStore(initialState: RegisterFeature.State(
            username: "neo", email: "neo@x.com", password: "Secret1", confirmPassword: "Secret1"
        )) {
            RegisterFeature()
        } withDependencies: {
            $0.authService.checkUsername = { _ in false }
            $0.authService.checkEmail = { _ in false }
            $0.authService.register = { _, _, _ in throw APIError.server(message: "服务器内部错误,请稍后重试") }
        }
        await store.send(.registerButtonTapped) { $0.isLoading = true }
        await store.receive(\.uniquenessChecked)
        await store.receive(\.registerFailed) {
            $0.isLoading = false
            $0.formError = "服务器内部错误,请稍后重试"
        }
    }
}
