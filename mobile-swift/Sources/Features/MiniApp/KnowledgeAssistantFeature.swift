import ComposableArchitecture

@Reducer
struct KnowledgeAssistantFeature {
    enum Tab: Equatable { case chat, documents, tasks }

    @ObservableState
    struct State: Equatable {
        var selectedTab: Tab = .chat
        var chat = AgentChatFeature.State()
    }

    enum Action: BindableAction {
        case binding(BindingAction<State>)
        case chat(AgentChatFeature.Action)
    }

    var body: some ReducerOf<Self> {
        BindingReducer()
        Scope(state: \.chat, action: \.chat) {
            AgentChatFeature()
        }
    }
}
