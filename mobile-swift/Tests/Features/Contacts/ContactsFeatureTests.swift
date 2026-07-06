import ComposableArchitecture
import Chats
import Services
import Core
import Models
import Testing
@testable import ContactBook

@MainActor
struct ContactsFeatureTests {
    @Test
    func onAppearLoadsContacts() async {
        let sample = [
            Contact(id: "1", name: "Alice", avatarURL: nil, sectionKey: "A"),
            Contact(id: "2", name: "Bob", avatarURL: nil, sectionKey: "B"),
        ]
        let store = TestStore(initialState: ContactsFeature.State()) {
            ContactsFeature()
        } withDependencies: {
            $0.contactsClient.contacts = { sample }
            // onAppear 现会订阅统一事件流,提供无副作用的 socket 依赖。
            $0.socketClient.connect = {}
            $0.socketClient.events = { .finished }
        }
        await store.send(.onAppear) { $0.isLoading = true }
        await store.receive(\.contactsResponse) {
            $0.isLoading = false
            $0.contacts = sample
        }
    }

    @Test
    func onAppearNoOpWhenAlreadyLoaded() async {
        var state = ContactsFeature.State()
        state.contacts = [Contact(id: "1", name: "Alice", avatarURL: nil, sectionKey: "A")]
        let store = TestStore(initialState: state) {
            ContactsFeature()
        } withDependencies: {
            $0.socketClient.connect = {}
            $0.socketClient.events = { .finished }
        }
        // 已有数据 → onAppear 不再重复拉取(仅订阅事件,无后续 action)。
        await store.send(.onAppear)
    }

    @Test
    func newFriendsTappedPresentsPage() async {
        let store = TestStore(initialState: ContactsFeature.State()) {
            ContactsFeature()
        }
        await store.send(.newFriendsTapped) {
            $0.path.append(.newFriends(NewFriendsFeature.State()))
        }
    }

    @Test
    func contactsFailedSetsError() async {
        let store = TestStore(initialState: ContactsFeature.State()) {
            ContactsFeature()
        } withDependencies: {
            $0.contactsClient.contacts = { throw APIError.transport(message: "x") }
            $0.socketClient.connect = {}
            $0.socketClient.events = { .finished }
        }
        await store.send(.onAppear) { $0.isLoading = true }
        await store.receive(\.contactsFailed) {
            $0.isLoading = false
            $0.loadError = "网络异常,请检查网络后重试"
        }
    }

    @Test
    func friendRequestReceivedSetsBadge() async {
        let store = TestStore(initialState: ContactsFeature.State()) {
            ContactsFeature()
        }
        await store.send(.friendRequestReceived) {
            $0.hasNewFriendRequest = true
        }
    }

    @Test
    func newFriendsTappedClearsBadge() async {
        var state = ContactsFeature.State()
        state.hasNewFriendRequest = true
        let store = TestStore(initialState: state) {
            ContactsFeature()
        }
        await store.send(.newFriendsTapped) {
            $0.hasNewFriendRequest = false
            $0.path.append(.newFriends(NewFriendsFeature.State()))
        }
    }

    @Test
    func friendListChangedReloadsContacts() async {
        var state = ContactsFeature.State()
        state.contacts = [Contact(id: "1", name: "A", avatarURL: nil, sectionKey: "A")]
        let updated = [Contact(id: "2", name: "B", avatarURL: nil, sectionKey: "B")]
        let store = TestStore(initialState: state) {
            ContactsFeature()
        } withDependencies: {
            $0.contactsClient.contacts = { updated }
        }
        await store.send(.friendListChangedReceived) { $0.isLoading = true }
        await store.receive(\.contactsResponse) {
            $0.isLoading = false
            $0.contacts = updated
        }
    }

    @Test
    func contactTappedPushesDetail() async {
        let contact = Contact(id: "1", name: "A", username: "A", sectionKey: "A")
        let store = TestStore(initialState: ContactsFeature.State()) {
            ContactsFeature()
        }
        await store.send(.contactTapped(contact)) {
            $0.path.append(.contactDetail(ContactDetailFeature.State(contact: contact)))
        }
    }

    @Test
    func detailOpenChatPushesChat() async {
        let contact = Contact(id: "2", name: "A", username: "A", sectionKey: "A")
        var state = ContactsFeature.State()
        state.path.append(.contactDetail(ContactDetailFeature.State(contact: contact)))
        let store = TestStore(initialState: state) {
            ContactsFeature()
        } withDependencies: {
            $0.sessionClient.currentUserId = { 1 }
        }
        await store.send(.path(.element(id: 0, action: .contactDetail(.delegate(.openChat(conversationId: "single_1_2", title: "A")))))) {
            $0.path.append(.chat(ChatDetailFeature.State(conversationId: "single_1_2", title: "A", currentUserId: 1)))
        }
    }

    @Test
    func detailOpenSettingsPushesFriendSettings() async {
        let contact = Contact(id: "2", name: "A", username: "A", sectionKey: "A")
        var state = ContactsFeature.State()
        state.path.append(.contactDetail(ContactDetailFeature.State(contact: contact)))
        let store = TestStore(initialState: state) {
            ContactsFeature()
        }
        await store.send(.path(.element(id: 0, action: .contactDetail(.delegate(.openSettings(contact)))))) {
            $0.path.append(.friendSettings(FriendSettingsFeature.State(contact: contact)))
        }
    }

    @Test
    func remarkUpdatedRecomputesDisplayNameAndSection() async {
        var state = ContactsFeature.State()
        let original = Contact(id: "1", name: "段宇皓", username: "段宇皓", remark: nil, sectionKey: "D")
        state.contacts = [original]
        state.path.append(.remarkEdit(RemarkEditFeature.State(contact: original)))
        let store = TestStore(initialState: state) {
            ContactsFeature()
        }
        await store.send(.path(.element(id: 0, action: .remarkEdit(.delegate(.remarkUpdated(friendId: "1", remark: "Bob")))))) {
            $0.contacts[0].remark = "Bob"
            $0.contacts[0].name = "Bob"
            $0.contacts[0].sectionKey = "B"
        }
    }
}
