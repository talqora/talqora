import ComposableArchitecture

@Reducer
struct MiniAppFeature {
    @ObservableState
    struct State: Equatable {
        var authorized: Bool = false
        var auth = AgentAuthFeature.State()
        var assistant = KnowledgeAssistantFeature.State()
    }

    enum Action {
        case onAppear
        case auth(AgentAuthFeature.Action)
        case assistant(KnowledgeAssistantFeature.Action)
    }

    @Dependency(\.agentAuth) var agentAuth

    var body: some ReducerOf<Self> {
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
