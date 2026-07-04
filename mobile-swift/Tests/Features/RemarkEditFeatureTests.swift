import ComposableArchitecture
import Foundation
import Testing
@testable import OurChat

@MainActor
struct RemarkEditFeatureTests {
    private let contact = Contact(id: "1024", name: "段宇皓", username: "段宇皓", remark: nil, sectionKey: "D")

    @Test
    func saveUpdatesRemarkAndEmitsDelegate() async {
        let store = TestStore(initialState: RemarkEditFeature.State(contact: contact)) {
            RemarkEditFeature()
        } withDependencies: {
            $0.contactsClient.updateRemark = { _, _ in }
            $0.dismiss = DismissEffect {}
        }
        await store.send(.binding(.set(\.remarkDraft, "老段"))) { $0.remarkDraft = "老段" }
        await store.send(.saveTapped) { $0.isSaving = true }
        await store.receive(\.saved) { $0.isSaving = false }
        await store.receive(\.delegate)
    }

    @Test
    func saveFailureShowsAlert() async {
        let store = TestStore(initialState: RemarkEditFeature.State(contact: contact)) {
            RemarkEditFeature()
        } withDependencies: {
            $0.contactsClient.updateRemark = { _, _ in throw APIError.server(message: "网络异常") }
        }
        await store.send(.saveTapped) { $0.isSaving = true }
        await store.receive(\.saveFailed) {
            $0.isSaving = false
            $0.alert = AlertState {
                TextState("备注保存失败")
            } message: {
                TextState("网络异常")
            }
        }
    }
}
