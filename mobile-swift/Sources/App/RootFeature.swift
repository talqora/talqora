import ComposableArchitecture
import Auth
import Core
import Foundation

@Reducer
struct RootFeature {
    @ObservableState
    enum State: Equatable {
        case loading
        case login(AuthFeature.State)
        case main(MainFeature.State)

        init() {
            self = .loading
        }
    }

    enum Action {
        case onAppear
        case login(AuthFeature.Action)
        case main(MainFeature.Action)
    }

    @Dependency(\.keychain) var keychain

    var body: some ReducerOf<Self> {
        Reduce { state, action in
            switch action {
            case .onAppear:
                let storedToken = (try? keychain.load(.accessToken)) ?? nil
                state = storedToken == nil ? .login(AuthFeature.State()) : .main(MainFeature.State())
                return .none

            case .login(.delegate(.loggedIn)):
                state = .main(MainFeature.State())
                return .none

            case .login:
                return .none

            case .main(.delegate(.loggedOut)):
                state = .login(AuthFeature.State())
                return .none

            case .main:
                return .none
            }
        }
        .ifCaseLet(\.login, action: \.login) {
            AuthFeature()
        }
        .ifCaseLet(\.main, action: \.main) {
            MainFeature()
        }
    }
}
