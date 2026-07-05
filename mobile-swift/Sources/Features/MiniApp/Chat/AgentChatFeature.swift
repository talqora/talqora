import ComposableArchitecture
import Foundation

@Reducer
struct AgentChatFeature {
    enum ListPhase: Equatable { case idle, loading, loaded, empty, failed }

    @ObservableState
    struct State: Equatable {
        var conversations: [AgentConversation] = []
        var listPhase: ListPhase = .idle
        var currentConversationId: Int?
        var messages: [AgentMessage] = []
        var input: String = ""
        var isStreaming = false
        var errorMessage: String?
        // 当前进入详情的会话标题(供导航栏展示)。
        var currentTitle: String = "对话"
    }

    enum Action: BindableAction {
        case binding(BindingAction<State>)
        case onAppear
        case loadConversations
        case conversationsResponse(Result<[AgentConversation], Error>)
        case createTapped
        case conversationCreated(AgentConversation)
        case createFailed
        case select(Int)
        case messagesLoaded([AgentMessage])
        case detailLoadFailed
        case deleteTapped(Int)
        case deleted(Int)
        case sendTapped
        case streamEvent(ChatStreamEvent)
        case streamFailed
        case dismissDetail
    }

    @Dependency(\.agentAPI) var agentAPI

    private enum CancelID { case stream }

    var body: some ReducerOf<Self> {
        BindingReducer()
        Reduce { state, action in
            switch action {
            case .binding:
                return .none

            case .onAppear:
                // 已加载过就不重复拉,避免每次切 tab 都刷。
                guard state.listPhase == .idle else { return .none }
                return .send(.loadConversations)

            case .loadConversations:
                state.listPhase = .loading
                return .run { send in
                    await send(.conversationsResponse(Result {
                        let data = try await agentAPI.request(.get("/conversations"))
                        return try JSONDecoder().decode([AgentConversation].self, from: data)
                    }))
                }

            case let .conversationsResponse(.success(list)):
                state.conversations = list
                state.listPhase = list.isEmpty ? .empty : .loaded
                return .none

            case .conversationsResponse(.failure):
                state.listPhase = .failed
                state.errorMessage = "会话加载失败,请重试"
                return .none

            case .createTapped:
                let body = try? JSONSerialization.data(withJSONObject: ["title": "新对话"])
                return .run { send in
                    let data = try await agentAPI.request(.post("/conversations", body))
                    let conv = try JSONDecoder().decode(AgentConversation.self, from: data)
                    await send(.conversationCreated(conv))
                } catch: { _, send in
                    await send(.createFailed)
                }

            case let .conversationCreated(conv):
                state.conversations.insert(conv, at: 0)
                state.listPhase = .loaded
                return .none

            case .createFailed:
                state.errorMessage = "创建对话失败,请重试"
                return .none

            case let .select(id):
                state.currentConversationId = id
                state.currentTitle = state.conversations.first { $0.id == id }?.title ?? "对话"
                state.messages = []
                state.errorMessage = nil
                return .run { send in
                    do {
                        let data = try await agentAPI.request(.get("/conversations/\(id)"))
                        let conv = try JSONDecoder().decode(AgentConversation.self, from: data)
                        await send(.messagesLoaded(conv.messages ?? []))
                    } catch {
                        await send(.detailLoadFailed)
                    }
                }
                .cancellable(id: CancelID.stream, cancelInFlight: true)

            case let .messagesLoaded(messages):
                state.messages = messages
                return .none

            case .detailLoadFailed:
                state.errorMessage = "消息加载失败,请重试"
                return .none

            case let .deleteTapped(id):
                state.conversations.removeAll { $0.id == id }
                if state.conversations.isEmpty { state.listPhase = .empty }
                if state.currentConversationId == id {
                    state.currentConversationId = nil
                    state.messages = []
                }
                return .run { send in
                    _ = try await agentAPI.request(.delete("/conversations/\(id)"))
                    await send(.deleted(id))
                } catch: { _, _ in }

            case .deleted:
                return .none

            case .sendTapped:
                let trimmed = state.input.trimmingCharacters(in: .whitespacesAndNewlines)
                guard let id = state.currentConversationId, !trimmed.isEmpty, !state.isStreaming else { return .none }
                let query = state.input
                state.input = ""
                state.messages.append(AgentMessage(id: -1, role: "user", content: query, citations: nil))
                state.messages.append(AgentMessage(id: -2, role: "assistant", content: "", citations: nil))
                state.isStreaming = true
                let body = try? JSONSerialization.data(withJSONObject: ["query": query, "topK": 6] as [String: Any])
                return .run { send in
                    for try await frame in agentAPI.stream(.post("/conversations/\(id)/messages", body)) {
                        await send(.streamEvent(try ChatStreamEvent.decode(event: frame.event, data: frame.data)))
                    }
                } catch: { _, send in
                    await send(.streamFailed)
                }
                .cancellable(id: CancelID.stream, cancelInFlight: true)

            case let .streamEvent(event):
                guard !state.messages.isEmpty else { return .none }
                let last = state.messages.count - 1
                switch event {
                case let .token(value):
                    state.messages[last].content += value
                    return .none
                case let .done(messageId, citations):
                    state.messages[last].id = messageId
                    // 空引用不写回,保持占位的 nil(避免无来源时渲染空来源条)。
                    if !citations.isEmpty { state.messages[last].citations = citations }
                    state.isStreaming = false
                    return .cancel(id: CancelID.stream)
                case let .error(message):
                    state.messages[last].content = message.isEmpty ? "回答生成失败,请重试" : message
                    state.isStreaming = false
                    return .cancel(id: CancelID.stream)
                }

            case .streamFailed:
                state.isStreaming = false
                if let last = state.messages.indices.last {
                    state.messages[last].content = "回答生成失败,请重试"
                }
                return .cancel(id: CancelID.stream)

            case .dismissDetail:
                state.currentConversationId = nil
                state.messages = []
                return .cancel(id: CancelID.stream)
            }
        }
    }
}
