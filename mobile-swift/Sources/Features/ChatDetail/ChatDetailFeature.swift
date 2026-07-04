import ComposableArchitecture
import Foundation

// 聊天详情:加载历史消息(REST)+ 实时收发(socket)。
// 发送走乐观更新(先本地插一条,再 emit),服务端回显的 receiveMessage 按 clientMsgId 替换回填真实 id/seq。
@Reducer
struct ChatDetailFeature {
    @ObservableState
    struct State: Equatable {
        let conversationId: String
        var title: String
        var messages: [ChatMessage] = []
        var currentUserId: Int = 0
        var isLoading = false
        var loadFailed = false
        var draft = ""
        @Presents var alert: AlertState<Action.Alert>?
    }

    enum Action: BindableAction {
        case binding(BindingAction<State>)
        case onAppear
        case messagesResponse([ChatMessage])
        case messagesFailed(String)
        case sendButtonTapped
        case imageSelected(Data)
        case imageReady(url: String, clientMsgId: String)
        case fileSelected(data: Data, filename: String, mimeType: String)
        case fileReady(url: String, fileName: String, fileSize: Int, clientMsgId: String)
        case uploadFailed(String)
        case messageReceived(ChatMessage)
        case alert(PresentationAction<Alert>)
        case delegate(Delegate)

        enum Alert: Equatable { case retryLoad }

        enum Delegate: Equatable {
            // 本会话已读至 uptoSeq:父 reducer 据此清列表未读角标。
            case didRead(conversationId: String, uptoSeq: Int)
        }
    }

    @Dependency(\.chatClient) var chatClient
    @Dependency(\.sessionClient) var sessionClient
    @Dependency(\.socketClient) var socketClient
    @Dependency(\.uploadClient) var uploadClient
    @Dependency(\.uuid) var uuid
    @Dependency(\.date) var date

    private enum CancelID { case incoming }

    var body: some ReducerOf<Self> {
        BindingReducer()
        Reduce { state, action in
            switch action {
            case .onAppear:
                state.currentUserId = sessionClient.currentUserId() ?? 0
                state.isLoading = true
                state.loadFailed = false
                return .merge(
                    loadMessages(state.conversationId),
                    .run { send in
                        // events() 内部自动建连(先订阅再连接),这里只消费消息事件。
                        for await event in socketClient.events() {
                            if case let .message(message) = event {
                                await send(.messageReceived(message))
                            }
                        }
                    }
                    .cancellable(id: CancelID.incoming, cancelInFlight: true)
                )

            case let .messagesResponse(messages):
                state.isLoading = false
                state.loadFailed = false
                state.messages = messages
                return markRead(conversationId: state.conversationId, messages: messages)

            case let .messagesFailed(message):
                // 加载失败弹可重试提示,不静默当空会话(§3)。
                state.isLoading = false
                state.loadFailed = true
                state.alert = AlertState {
                    TextState("加载消息失败")
                } actions: {
                    ButtonState(action: .retryLoad) { TextState("重试") }
                    ButtonState(role: .cancel) { TextState("取消") }
                } message: {
                    TextState(message)
                }
                return .none

            case .sendButtonTapped:
                let content = state.draft.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !content.isEmpty else { return .none }
                let outgoing = OutgoingMessage(
                    conversationId: state.conversationId,
                    clientMsgId: uuid().uuidString,
                    content: content
                )
                let optimistic = ChatMessage(
                    serverId: 0,
                    conversationId: outgoing.conversationId,
                    senderId: state.currentUserId,
                    seq: nil,
                    content: content,
                    type: outgoing.type,
                    timestamp: date.now,
                    clientMsgId: outgoing.clientMsgId
                )
                mergeMessage(into: &state.messages, optimistic)
                state.draft = ""
                return .run { _ in socketClient.send(outgoing) }

            case let .imageSelected(data):
                // 先上传拿到 URL,再当作一条 image 消息发送(乐观插入在拿到 URL 后)。
                let clientMsgId = uuid().uuidString
                return .run { send in
                    let url = try await uploadClient.uploadImage(data, "image.jpg")
                    await send(.imageReady(url: url.absoluteString, clientMsgId: clientMsgId))
                } catch: { error, send in
                    await send(.uploadFailed(loadErrorMessage(error)))
                }

            case let .imageReady(url, clientMsgId):
                let outgoing = OutgoingMessage(
                    conversationId: state.conversationId,
                    clientMsgId: clientMsgId,
                    content: url,
                    type: "image"
                )
                let optimistic = ChatMessage(
                    serverId: 0,
                    conversationId: state.conversationId,
                    senderId: state.currentUserId,
                    seq: nil,
                    content: url,
                    type: "image",
                    timestamp: date.now,
                    clientMsgId: clientMsgId
                )
                mergeMessage(into: &state.messages, optimistic)
                return .run { _ in socketClient.send(outgoing) }

            case let .fileSelected(data, filename, mimeType):
                let clientMsgId = uuid().uuidString
                let size = data.count
                return .run { send in
                    let url = try await uploadClient.uploadFile(data, filename, mimeType)
                    await send(.fileReady(url: url.absoluteString, fileName: filename, fileSize: size, clientMsgId: clientMsgId))
                } catch: { error, send in
                    await send(.uploadFailed(loadErrorMessage(error)))
                }

            case let .fileReady(url, fileName, fileSize, clientMsgId):
                let fileInfo = MessageFileInfo(fileName: fileName, fileSize: fileSize, fileUrl: url)
                let outgoing = OutgoingMessage(
                    conversationId: state.conversationId,
                    clientMsgId: clientMsgId,
                    content: "[文件]",
                    type: "file",
                    fileInfo: fileInfo
                )
                let optimistic = ChatMessage(
                    serverId: 0,
                    conversationId: state.conversationId,
                    senderId: state.currentUserId,
                    seq: nil,
                    content: "[文件]",
                    type: "file",
                    timestamp: date.now,
                    clientMsgId: clientMsgId,
                    fileInfo: fileInfo
                )
                mergeMessage(into: &state.messages, optimistic)
                return .run { _ in socketClient.send(outgoing) }

            case let .uploadFailed(message):
                state.alert = AlertState {
                    TextState("发送失败")
                } message: {
                    TextState(message)
                }
                return .none

            case let .messageReceived(message):
                guard message.conversationId == state.conversationId else { return .none }
                mergeMessage(into: &state.messages, message)
                // 对方发来的消息:页面在前台即视为已读,上报并清角标。自己的回显不触发。
                guard message.senderId != state.currentUserId else { return .none }
                return markRead(conversationId: state.conversationId, messages: state.messages)

            case .alert(.presented(.retryLoad)):
                state.isLoading = true
                state.loadFailed = false
                return loadMessages(state.conversationId)

            case .binding, .delegate, .alert:
                return .none
            }
        }
        .ifLet(\.$alert, action: \.alert)
    }

    // 拉历史消息;失败发 messagesFailed(弹重试),不静默当空。
    private func loadMessages(_ conversationId: String) -> Effect<Action> {
        .run { send in
            let messages = try await chatClient.messages(conversationId)
            await send(.messagesResponse(messages))
        } catch: { error, send in
            await send(.messagesFailed(loadErrorMessage(error)))
        }
    }

    // 取已加载消息的最大 seq 作为已读位点:socket 上报 + 通知父清未读。无 seq(纯乐观)则不发。
    private func markRead(conversationId: String, messages: [ChatMessage]) -> Effect<Action> {
        guard let uptoSeq = messages.compactMap(\.seq).max(), uptoSeq > 0 else { return .none }
        return .merge(
            .run { _ in socketClient.reportRead(conversationId, uptoSeq) },
            .send(.delegate(.didRead(conversationId: conversationId, uptoSeq: uptoSeq)))
        )
    }
}

// 去重合并:优先按 clientMsgId 命中(乐观消息被服务端回显替换),否则按 serverId 命中,都不中则追加。
private func mergeMessage(into messages: inout [ChatMessage], _ message: ChatMessage) {
    if let clientMsgId = message.clientMsgId,
       let index = messages.firstIndex(where: { $0.clientMsgId == clientMsgId }) {
        messages[index] = message
    } else if message.serverId != 0,
              let index = messages.firstIndex(where: { $0.serverId == message.serverId }) {
        messages[index] = message
    } else {
        messages.append(message)
    }
}
