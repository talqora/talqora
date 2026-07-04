import ComposableArchitecture
import Foundation
import Testing
@testable import OurChat

@MainActor
struct ContactDetailFeatureTests {
    private let contact = Contact(id: "2", name: "段宇皓", username: "段宇皓", remark: nil, sectionKey: "D")

    @Test
    func messageTappedEmitsOpenChatWithConversationId() async {
        let store = TestStore(initialState: ContactDetailFeature.State(contact: contact)) {
            ContactDetailFeature()
        } withDependencies: {
            $0.sessionClient.currentUserId = { 1 }
        }
        await store.send(.messageTapped)
        await store.receive(\.delegate) // .openChat(conversationId: "single_1_2", title: "段宇皓")
    }

    @Test
    func settingsTappedEmitsOpenSettings() async {
        let store = TestStore(initialState: ContactDetailFeature.State(contact: contact)) {
            ContactDetailFeature()
        }
        await store.send(.settingsTapped)
        await store.receive(\.delegate) // .openSettings(contact)
    }
}
