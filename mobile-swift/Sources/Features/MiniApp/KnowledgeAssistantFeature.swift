import ComposableArchitecture

@Reducer
struct KnowledgeAssistantFeature {
    enum Tab: Equatable { case chat, documents, tasks }

    @ObservableState
    struct State: Equatable {
        var selectedTab: Tab = .chat
    }

    enum Action: BindableAction {
        case binding(BindingAction<State>)
    }

    var body: some ReducerOf<Self> {
        BindingReducer()
    }
}
