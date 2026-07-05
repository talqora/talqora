import ComposableArchitecture
import Testing
import Foundation
@testable import OurChat

@MainActor
struct AgentDocumentsFeatureTests {

    @Test func loadPopulatesList() async {
        let json = #"[{"id":1,"filename":"a.pdf","status":"ready","chunkCount":10}]"#
        let store = TestStore(initialState: AgentDocumentsFeature.State()) {
            AgentDocumentsFeature()
        } withDependencies: {
            $0.agentAPI.request = { _ in Data(json.utf8) }
        }
        await store.send(.onAppear) { $0.phase = .loading }
        await store.receive(\.documentsResponse.success) {
            $0.phase = .loaded
            $0.documents = [AgentDocument(id: 1, filename: "a.pdf", size: nil, chunkCount: 10, status: "ready", error: nil)]
        }
    }

    @Test func loadEmptyShowsEmptyState() async {
        let store = TestStore(initialState: AgentDocumentsFeature.State()) {
            AgentDocumentsFeature()
        } withDependencies: {
            $0.agentAPI.request = { _ in Data("[]".utf8) }
        }
        await store.send(.onAppear) { $0.phase = .loading }
        await store.receive(\.documentsResponse.success) {
            $0.phase = .empty
            $0.documents = []
        }
    }

    @Test func loadFailureShowsError() async {
        let store = TestStore(initialState: AgentDocumentsFeature.State()) {
            AgentDocumentsFeature()
        } withDependencies: {
            $0.agentAPI.request = { _ in throw AgentAPIError.http(500) }
        }
        await store.send(.onAppear) { $0.phase = .loading }
        await store.receive(\.documentsResponse.failure) {
            $0.phase = .failed
            $0.errorMessage = "文档加载失败,请重试"
        }
    }

    @Test func deleteRemovesDocument() async {
        var state = AgentDocumentsFeature.State()
        state.phase = .loaded
        state.documents = [AgentDocument(id: 1, filename: "a.pdf", size: nil, chunkCount: nil, status: "ready", error: nil)]
        let store = TestStore(initialState: state) {
            AgentDocumentsFeature()
        } withDependencies: {
            $0.agentAPI.request = { _ in Data() }
        }
        await store.send(.deleteTapped(1)) {
            $0.documents = []
            $0.phase = .empty
        }
    }
}
