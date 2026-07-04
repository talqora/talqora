import ComposableArchitecture
import Foundation
import Testing
@testable import OurChat

@MainActor
struct ChatDetailFeatureTests {
    @Test
    func onAppearLoadsHistoryAndSubscribes() async {
        let history = [
            ChatMessage(serverId: 1, conversationId: "single_1_2", senderId: 2, seq: 1, content: "hi", type: "text", timestamp: nil, clientMsgId: nil),
            ChatMessage(serverId: 2, conversationId: "single_1_2", senderId: 1, seq: 2, content: "yo", type: "text", timestamp: nil, clientMsgId: nil),
        ]
        let store = TestStore(
            initialState: ChatDetailFeature.State(conversationId: "single_1_2", title: "段宇皓")
        ) {
            ChatDetailFeature()
        } withDependencies: {
            $0.chatClient.messages = { _ in history }
            $0.sessionClient.currentUserId = { 1 }
            $0.socketClient.connect = {}
            $0.socketClient.reportRead = { _, _ in }
            $0.socketClient.events = { .finished }
        }
        await store.send(.onAppear) {
            $0.currentUserId = 1
            $0.isLoading = true
        }
        await store.receive(\.messagesResponse) {
            $0.isLoading = false
            $0.messages = history
        }
        // 历史含 seq,打开即已读 → 上报并发 didRead 委托。
        await store.receive(\.delegate)
    }

    @Test
    func messagesResponseReportsReadUpToMaxSeq() async {
        let (readStream, readContinuation) = AsyncStream<Int>.makeStream()
        let history = [
            ChatMessage(serverId: 1, conversationId: "single_1_2", senderId: 2, seq: 3, content: "a", type: "text", timestamp: nil, clientMsgId: nil),
            ChatMessage(serverId: 2, conversationId: "single_1_2", senderId: 2, seq: 7, content: "b", type: "text", timestamp: nil, clientMsgId: nil),
        ]
        let store = TestStore(
            initialState: ChatDetailFeature.State(conversationId: "single_1_2", title: "x")
        ) {
            ChatDetailFeature()
        } withDependencies: {
            $0.socketClient.reportRead = { _, seq in readContinuation.yield(seq); readContinuation.finish() }
        }
        await store.send(.messagesResponse(history)) {
            $0.messages = history
        }
        await store.receive(\.delegate)
        var reported: Int?
        for await seq in readStream { reported = seq; break }
        #expect(reported == 7)
    }

    @Test
    func sendInsertsOptimisticMessageAndEmits() async {
        let (sentStream, sentContinuation) = AsyncStream<OutgoingMessage>.makeStream()
        let store = TestStore(
            initialState: ChatDetailFeature.State(conversationId: "single_1_2", title: "段宇皓")
        ) {
            ChatDetailFeature()
        } withDependencies: {
            $0.chatClient.messages = { _ in [] }
            $0.sessionClient.currentUserId = { 1 }
            $0.socketClient.connect = {}
            $0.socketClient.events = { .finished }
            $0.socketClient.send = { sentContinuation.yield($0); sentContinuation.finish() }
            $0.uuid = .incrementing
            $0.date = .constant(Date(timeIntervalSince1970: 0))
        }
        await store.send(.onAppear) {
            $0.currentUserId = 1
            $0.isLoading = true
        }
        await store.receive(\.messagesResponse) {
            $0.isLoading = false
        }
        await store.send(.binding(.set(\.draft, "你好"))) {
            $0.draft = "你好"
        }
        let optimistic = ChatMessage(
            serverId: 0, conversationId: "single_1_2", senderId: 1, seq: nil,
            content: "你好", type: "text",
            timestamp: Date(timeIntervalSince1970: 0),
            clientMsgId: "00000000-0000-0000-0000-000000000000"
        )
        await store.send(.sendButtonTapped) {
            $0.messages = [optimistic]
            $0.draft = ""
        }
        var sent: OutgoingMessage?
        for await message in sentStream { sent = message; break }
        #expect(sent == OutgoingMessage(
            conversationId: "single_1_2",
            clientMsgId: "00000000-0000-0000-0000-000000000000",
            content: "你好"
        ))
    }

    @Test
    func serverEchoReplacesOptimisticByClientMsgId() async {
        let store = TestStore(
            initialState: ChatDetailFeature.State(conversationId: "single_1_2", title: "段宇皓")
        ) {
            ChatDetailFeature()
        } withDependencies: {
            $0.socketClient.send = { _ in }
            $0.uuid = .incrementing
            $0.date = .constant(Date(timeIntervalSince1970: 0))
        }
        await store.send(.binding(.set(\.draft, "hi"))) {
            $0.draft = "hi"
        }
        let optimistic = ChatMessage(
            serverId: 0, conversationId: "single_1_2", senderId: 0, seq: nil,
            content: "hi", type: "text",
            timestamp: Date(timeIntervalSince1970: 0),
            clientMsgId: "00000000-0000-0000-0000-000000000000"
        )
        await store.send(.sendButtonTapped) {
            $0.messages = [optimistic]
            $0.draft = ""
        }
        let echo = ChatMessage(
            serverId: 42, conversationId: "single_1_2", senderId: 0, seq: 5,
            content: "hi", type: "text", timestamp: nil,
            clientMsgId: "00000000-0000-0000-0000-000000000000"
        )
        await store.send(.messageReceived(echo)) {
            $0.messages = [echo]
        }
    }

    @Test
    func ignoresMessageFromOtherConversation() async {
        let store = TestStore(
            initialState: ChatDetailFeature.State(conversationId: "single_1_2", title: "段宇皓")
        ) {
            ChatDetailFeature()
        }
        let other = ChatMessage(
            serverId: 7, conversationId: "single_3_4", senderId: 3, seq: 1,
            content: "外会话", type: "text", timestamp: nil, clientMsgId: nil
        )
        await store.send(.messageReceived(other))
    }

    @Test
    func imageSelectedUploadsThenSendsImageMessage() async {
        let (sentStream, sentContinuation) = AsyncStream<OutgoingMessage>.makeStream()
        let store = TestStore(
            initialState: ChatDetailFeature.State(conversationId: "single_1_2", title: "段宇皓")
        ) {
            ChatDetailFeature()
        } withDependencies: {
            $0.uploadClient.uploadImage = { _, _ in URL(string: "https://cdn/x/a.jpg")! }
            $0.socketClient.send = { sentContinuation.yield($0); sentContinuation.finish() }
            $0.uuid = .incrementing
            $0.date = .constant(Date(timeIntervalSince1970: 0))
        }
        await store.send(.imageSelected(Data([0x1])))
        await store.receive(\.imageReady) {
            $0.messages = [
                ChatMessage(
                    serverId: 0, conversationId: "single_1_2", senderId: 0, seq: nil,
                    content: "https://cdn/x/a.jpg", type: "image",
                    timestamp: Date(timeIntervalSince1970: 0),
                    clientMsgId: "00000000-0000-0000-0000-000000000000"
                )
            ]
        }
        var sent: OutgoingMessage?
        for await message in sentStream { sent = message; break }
        #expect(sent?.type == "image")
        #expect(sent?.content == "https://cdn/x/a.jpg")
    }

    @Test
    func fileSelectedUploadsThenSendsFileMessage() async {
        let (sentStream, sentContinuation) = AsyncStream<OutgoingMessage>.makeStream()
        let store = TestStore(
            initialState: ChatDetailFeature.State(conversationId: "single_1_2", title: "段宇皓")
        ) {
            ChatDetailFeature()
        } withDependencies: {
            $0.uploadClient.uploadFile = { _, _, _ in URL(string: "https://cdn/x/report.pdf")! }
            $0.socketClient.send = { sentContinuation.yield($0); sentContinuation.finish() }
            $0.uuid = .incrementing
            $0.date = .constant(Date(timeIntervalSince1970: 0))
        }
        await store.send(.fileSelected(data: Data([0x1, 0x2, 0x3]), filename: "report.pdf", mimeType: "application/pdf"))
        await store.receive(\.fileReady) {
            $0.messages = [
                ChatMessage(
                    serverId: 0, conversationId: "single_1_2", senderId: 0, seq: nil,
                    content: "[文件]", type: "file",
                    timestamp: Date(timeIntervalSince1970: 0),
                    clientMsgId: "00000000-0000-0000-0000-000000000000",
                    fileInfo: MessageFileInfo(fileName: "report.pdf", fileSize: 3, fileUrl: "https://cdn/x/report.pdf")
                )
            ]
        }
        var sent: OutgoingMessage?
        for await message in sentStream { sent = message; break }
        #expect(sent?.type == "file")
        #expect(sent?.fileInfo?.fileName == "report.pdf")
        #expect(sent?.fileInfo?.fileSize == 3)
    }

    @Test
    func messagesFailedShowsRetryAlert() async {
        let store = TestStore(
            initialState: ChatDetailFeature.State(conversationId: "single_1_2", title: "x")
        ) {
            ChatDetailFeature()
        } withDependencies: {
            $0.chatClient.messages = { _ in throw APIError.transport(message: "x") }
            $0.sessionClient.currentUserId = { 1 }
            $0.socketClient.connect = {}
            $0.socketClient.events = { .finished }
        }
        await store.send(.onAppear) {
            $0.currentUserId = 1
            $0.isLoading = true
        }
        await store.receive(\.messagesFailed) {
            $0.isLoading = false
            $0.loadFailed = true
            $0.alert = AlertState {
                TextState("加载消息失败")
            } actions: {
                ButtonState(action: .retryLoad) { TextState("重试") }
                ButtonState(role: .cancel) { TextState("取消") }
            } message: {
                TextState("网络异常,请检查网络后重试")
            }
        }
    }

    @Test
    func videoCallTileEmitsStartCallWithPeerId() async {
        // 会话 single_1_2、本端 id=1 → 对端 id=2;选「视频通话」应上抛 .startCall(peer.id=2, .video)。
        let initial = ChatDetailFeature.State(
            conversationId: "single_1_2", title: "段宇皓", peerAvatar: "https://cdn/x/a.jpg", currentUserId: 1
        )
        // 被叫资料从单聊会话 id 解出:id=对端(2),昵称/头像取会话标题与头像。
        #expect(initial.isGroupConversation == false)
        #expect(initial.callPeer() == CallUserDTO(id: 2, username: "", nickname: "段宇皓", avatar: "https://cdn/x/a.jpg"))

        let store = TestStore(initialState: initial) {
            ChatDetailFeature()
        }
        await store.send(.videoCallTileTapped) {
            $0.callDialog = ConfirmationDialogState {
                TextState("选择通话方式")
            } actions: {
                ButtonState(action: .video) { TextState("视频通话") }
                ButtonState(action: .voice) { TextState("语音通话") }
                ButtonState(role: .cancel) { TextState("取消") }
            }
        }
        await store.send(.callDialog(.presented(.video))) {
            $0.callDialog = nil
        }
        await store.receive(\.delegate) // .startCall(peer.id=2, .video)
    }

    @Test
    func groupConversationHidesCall() async {
        // 群聊会话 id 非 single_ 形状 → isGroupConversation=true,视频通话磁贴不出现。
        let store = TestStore(
            initialState: ChatDetailFeature.State(conversationId: "group_42", title: "项目群", currentUserId: 1)
        ) {
            ChatDetailFeature()
        }
        #expect(store.state.isGroupConversation == true)
        // 防御:即便误触磁贴,群聊也不弹选择框。
        await store.send(.videoCallTileTapped)
    }

    @Test
    func plusTogglesFunctionPanel() async {
        let store = TestStore(
            initialState: ChatDetailFeature.State(conversationId: "single_1_2", title: "x", currentUserId: 1)
        ) {
            ChatDetailFeature()
        }
        await store.send(.plusTapped) { $0.showFunctionPanel = true }
        await store.send(.plusTapped) { $0.showFunctionPanel = false }
    }

    @Test
    func imageUploadFailureShowsAlert() async {
        let store = TestStore(
            initialState: ChatDetailFeature.State(conversationId: "single_1_2", title: "x")
        ) {
            ChatDetailFeature()
        } withDependencies: {
            $0.uploadClient.uploadImage = { _, _ in throw APIError.server(message: "上传失败") }
            $0.uuid = .incrementing
        }
        await store.send(.imageSelected(Data([0x1])))
        await store.receive(\.uploadFailed) {
            $0.alert = AlertState {
                TextState("发送失败")
            } message: {
                TextState("上传失败")
            }
        }
    }
}
