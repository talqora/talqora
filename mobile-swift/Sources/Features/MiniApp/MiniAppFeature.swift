import ComposableArchitecture
import Services

@Reducer
public struct MiniAppFeature: Sendable {
    public init() {}

    @ObservableState
    public struct State: Equatable {
        public init(authorized: Bool = false) {
            self.authorized = authorized
        }
        var authorized: Bool = false
        var auth = AgentAuthFeature.State()
        var assistant = KnowledgeAssistantFeature.State()
    }

    public enum Action {
        case onAppear
        case auth(AgentAuthFeature.Action)
        case assistant(KnowledgeAssistantFeature.Action)
    }

    @Dependency(\.agentAuth) var agentAuth

    public var body: some ReducerOf<Self> {
        Scope(state: \.auth, action: \.auth) { AgentAuthFeature() }
        Scope(state: \.assistant, action: \.assistant) { KnowledgeAssistantFeature() }
        Reduce { state, action in
            switch action {
            case .onAppear:
                state.authorized = agentAuth.isAuthorized()
                return .none
            case .auth(.delegate(.authorized)):
                state.authorized = true
                return .none
            case .auth, .assistant:
                return .none
            }
        }
    }
}
