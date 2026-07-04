import ComposableArchitecture
import Foundation

@Reducer
struct ChatsFeature {
    @ObservableState
    struct State: Equatable {
        var conversations: [Conversation] = []
        var otherDeviceCount = 0
        var isLoading = false
        var loadError: String?
        // 搜索页(全屏覆盖呈现)。
        @Presents var search: SearchFeature.State?
        // 导航栈:点会话推入聊天详情页。
        var path = StackState<ChatDetailFeature.State>()
    }

    enum Action: BindableAction {
        case binding(BindingAction<State>)
        case onAppear
        case reloadTapped
        case conversationsResponse([Conversation], deviceCount: Int)
        case conversationsFailed(String)
        case conversationTapped(Conversation)
        case searchButtonTapped
        case search(PresentationAction<SearchFeature.Action>)
        case path(StackActionOf<ChatDetailFeature>)
        case delegate(Delegate)

        enum Delegate: Equatable {
            // 聊天详情页发起通话:上抛给 MainFeature 呈现通话。
            case startCall(peer: CallUserDTO, type: CallType)
        }
    }

    @Dependency(\.chatClient) var chatClient

    var body: some ReducerOf<Self> {
        BindingReducer()
        Reduce { state, action in
            switch action {
            case .onAppear:
                guard state.conversations.isEmpty, !state.isLoading else { return .none }
                return load(&state)

            case .reloadTapped:
                return load(&state)

            case let .conversationsResponse(conversations, deviceCount):
                state.isLoading = false
                state.loadError = nil
                state.conversations = conversations
                state.otherDeviceCount = deviceCount
                return .none

            case let .conversationsFailed(message):
                // 失败留在 error 态(带重试),不静默当空(§3)。
                state.isLoading = false
                state.loadError = message
                return .none

            case let .conversationTapped(conversation):
                state.path.append(
                    ChatDetailFeature.State(
                        conversationId: conversation.id,
                        title: conversation.title,
                        peerAvatar: conversation.avatarURL?.absoluteString ?? ""
                    )
                )
                return .none

            case .searchButtonTapped:
                state.search = SearchFeature.State()
                return .none

            case .search(.presented(.delegate(.close))):
                state.search = nil
                return .none

            case let .path(.element(id: _, action: .delegate(.didRead(conversationId, _)))):
                // 打开会话即清该会话未读角标/红点(服务端已读上报由详情页负责)。
                if let index = state.conversations.firstIndex(where: { $0.id == conversationId }) {
                    state.conversations[index].unreadCount = 0
                    state.conversations[index].hasRedDot = false
                }
                return .none

            // 聊天详情页发起语音/视频通话 → 上抛父层呈现。
            case let .path(.element(id: _, action: .delegate(.startCall(peer, type)))):
                return .send(.delegate(.startCall(peer: peer, type: type)))

            case .binding, .path, .search, .delegate:
                return .none
            }
        }
        .ifLet(\.$search, action: \.search) {
            SearchFeature()
        }
        .forEach(\.path, action: \.path) {
            ChatDetailFeature()
        }
    }

    // 拉会话列表 + 其它设备数;失败进 error 态(带重试),不静默当空。
    private func load(_ state: inout State) -> Effect<Action> {
        state.isLoading = true
        state.loadError = nil
        return .run { send in
            // 会话为关键数据,设备数非关键:并行拉取,设备数失败按 0,不因它拖垮整屏。
            async let conversationsTask = chatClient.conversations()
            async let deviceCountTask = chatClient.otherDeviceCount()
            let conversations = try await conversationsTask
            let deviceCount = (try? await deviceCountTask) ?? 0
            await send(.conversationsResponse(conversations, deviceCount: deviceCount))
        } catch: { error, send in
            await send(.conversationsFailed(loadErrorMessage(error)))
        }
    }
}
