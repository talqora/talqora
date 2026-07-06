import ComposableArchitecture
import Search
import Services
import Core
import Models
import Testing
@testable import Chats

@MainActor
struct ChatsFeatureTests {
    @Test
    func onAppearLoadsConversations() async {
        let sample = [
            Conversation(id: "1", title: "段宇皓", preview: "OK", timeText: "昨天"),
        ]
        let store = TestStore(initialState: ChatsFeature.State()) {
            ChatsFeature()
        } withDependencies: {
            $0.chatClient.conversations = { sample }
            $0.chatClient.otherDeviceCount = { 0 }
        }
        await store.send(.onAppear) { $0.isLoading = true }
        await store.receive(\.conversationsResponse) {
            $0.isLoading = false
            $0.conversations = sample
            $0.otherDeviceCount = 0
        }
    }

    @Test
    func conversationTappedPushesDetail() async {
        let conversation = Conversation(id: "single_1_2", title: "段宇皓", preview: "OK", timeText: "昨天")
        let store = TestStore(initialState: ChatsFeature.State()) {
            ChatsFeature()
        }
        await store.send(.conversationTapped(conversation)) {
            $0.path.append(ChatDetailFeature.State(conversationId: "single_1_2", title: "段宇皓"))
        }
    }

    @Test
    func searchButtonPresentsAndCloseDismisses() async {
        let store = TestStore(initialState: ChatsFeature.State()) {
            ChatsFeature()
        }
        await store.send(.searchButtonTapped) {
            $0.search = SearchFeature.State()
        }
        await store.send(.search(.presented(.closeTapped)))
        await store.receive(\.search) {
            $0.search = nil
        }
    }

    @Test
    func detailDidReadClearsUnreadBadge() async {
        var conversation = Conversation(id: "single_1_2", title: "段宇皓", preview: "hi", timeText: "昨天")
        conversation.unreadCount = 5
        let store = TestStore(initialState: ChatsFeature.State(conversations: [conversation])) {
            ChatsFeature()
        }
        await store.send(.conversationTapped(conversation)) {
            $0.path.append(ChatDetailFeature.State(conversationId: "single_1_2", title: "段宇皓"))
        }
        await store.send(.path(.element(id: 0, action: .delegate(.didRead(conversationId: "single_1_2", uptoSeq: 7))))) {
            $0.conversations[0].unreadCount = 0
            $0.conversations[0].hasRedDot = false
        }
    }

    @Test
    func conversationsFailedSetsError() async {
        let store = TestStore(initialState: ChatsFeature.State()) {
            ChatsFeature()
        } withDependencies: {
            $0.chatClient.conversations = { throw APIError.transport(message: "x") }
            $0.chatClient.otherDeviceCount = { 0 }
        }
        await store.send(.onAppear) { $0.isLoading = true }
        await store.receive(\.conversationsFailed) {
            $0.isLoading = false
            $0.loadError = "网络异常,请检查网络后重试"
        }
    }
}
