import ComposableArchitecture

@Reducer
struct KnowledgeAssistantFeature {
    enum Tab: Equatable { case chat, documents, tasks }

    @ObservableState
    struct State: Equatable {
        var selectedTab: Tab = .chat
        var chat = AgentChatFeature.State()
        var documents = AgentDocumentsFeature.State()
        var tasks = AgentTasksFeature.State()
    }

    enum Action: BindableAction {
        case binding(BindingAction<State>)
        case chat(AgentChatFeature.Action)
        case documents(AgentDocumentsFeature.Action)
        case tasks(AgentTasksFeature.Action)
    }

    var body: some ReducerOf<Self> {
        BindingReducer()
        Scope(state: \.chat, action: \.chat) {
            AgentChatFeature()
        }
        Scope(state: \.documents, action: \.documents) {
            AgentDocumentsFeature()
        }
        Scope(state: \.tasks, action: \.tasks) {
            AgentTasksFeature()
        }
    }
}
