import ComposableArchitecture
@testable import Auth
import Services
import Core
import Models
import Foundation
import Testing

@MainActor
struct AuthFeatureTests {
    @Test
    func editingFieldsClearsError() async {
        let store = TestStore(initialState: AuthFeature.State(errorMessage: "旧错误")) {
            AuthFeature()
        }
        await store.send(.binding(.set(\.username, "alice"))) {
            $0.username = "alice"
            $0.errorMessage = nil
        }
    }

    @Test
    func successfulLoginEmitsDelegate() async {
        let tokens = AuthTokens(accessToken: "at", refreshToken: "rt")
        let store = TestStore(initialState: AuthFeature.State(username: "u", password: "p")) {
            AuthFeature()
        } withDependencies: {
            $0.authService.login = { _, _, _ in tokens }
        }
        await store.send(.loginButtonTapped) { $0.isLoading = true }
        await store.receive(\.loginSucceeded) { $0.isLoading = false }
        await store.receive(.delegate(.loggedIn(tokens)))
    }

    @Test
    func failedLoginShowsError() async {
        let store = TestStore(initialState: AuthFeature.State(username: "u", password: "p")) {
            AuthFeature()
        } withDependencies: {
            $0.authService.login = { _, _, _ in throw APIError.unauthorized }
        }
        await store.send(.loginButtonTapped) { $0.isLoading = true }
        await store.receive(\.loginFailed) {
            $0.isLoading = false
            $0.errorMessage = "用户名或密码错误"
        }
    }

    @Test
    func loginIgnoredWhenFieldsEmpty() async {
        let store = TestStore(initialState: AuthFeature.State()) {
            AuthFeature()
        }
        await store.send(.loginButtonTapped)
    }
}
