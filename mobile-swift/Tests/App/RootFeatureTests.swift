import ComposableArchitecture
import Auth
import Services
import Core
import Models
import Testing
@testable import OurChat

@MainActor
struct RootFeatureTests {
    @Test
    func routesToMainWhenTokenPresent() async throws {
        let keychain = KeychainStore.inMemory()
        try keychain.save("at", .accessToken)
        let store = TestStore(initialState: RootFeature.State()) {
            RootFeature()
        } withDependencies: {
            $0.keychain = keychain
        }
        await store.send(.onAppear) {
            $0 = .main(MainFeature.State())
        }
    }

    @Test
    func routesToLoginWhenNoToken() async {
        let store = TestStore(initialState: RootFeature.State()) {
            RootFeature()
        } withDependencies: {
            $0.keychain = .inMemory()
        }
        await store.send(.onAppear) {
            $0 = .login(AuthFeature.State())
        }
    }

    @Test
    func loggedInDelegateRoutesToMain() async {
        let store = TestStore(initialState: RootFeature.State.login(AuthFeature.State())) {
            RootFeature()
        }
        let tokens = AuthTokens(accessToken: "a", refreshToken: "r")
        await store.send(.login(.delegate(.loggedIn(tokens)))) {
            $0 = .main(MainFeature.State())
        }
    }

    @Test
    func loggedOutDelegateRoutesToLogin() async {
        let store = TestStore(initialState: RootFeature.State.main(MainFeature.State())) {
            RootFeature()
        } withDependencies: {
            $0.authService.logout = {}
        }
        await store.send(.main(.delegate(.loggedOut))) {
            $0 = .login(AuthFeature.State())
        }
    }
}
