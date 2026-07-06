import ComposableArchitecture
import Services

@Reducer
public struct AgentAuthFeature: Sendable {
    @ObservableState
    public struct State: Equatable {
        var isLoading = false
        var errorMessage: String?
    }

    public enum Action {
        case authorizeTapped
        case authorized
        case authorizeFailed
        case delegate(Delegate)

        public enum Delegate {
            case authorized
        }
    }

    @Dependency(\.agentAuth) var agentAuth

    public var body: some ReducerOf<Self> {
        Reduce { state, action in
            switch action {
            case .authorizeTapped:
                state.isLoading = true
                state.errorMessage = nil
                return .run { send in
                    try await agentAuth.authorize()
                    await send(.authorized)
                } catch: { _, send in
                    await send(.authorizeFailed)
                }

            case .authorized:
                state.isLoading = false
                return .send(.delegate(.authorized))

            case .authorizeFailed:
                state.isLoading = false
                state.errorMessage = "授权失败,请重试"
                return .none

            case .delegate:
                return .none
            }
        }
    }
}
