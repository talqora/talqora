import ComposableArchitecture
import Services
import Foundation
import Testing
@testable import MiniApp

@MainActor
struct AgentChatFeatureTests {
    @Test func sendStreamsTokensThenDone() async {
        let (stream, cont) = AsyncThrowingStream<SSEFrame, Error>.makeStream()
        var state = AgentChatFeature.State(); state.currentConversationId = 1; state.input = "你好"
        let store = TestStore(initialState: state) { AgentChatFeature() } withDependencies: {
            $0.agentAPI.stream = { _ in stream }
        }
        await store.send(.sendTapped) {
            $0.input = ""
            $0.messages.append(AgentMessage(id: -1, role: "user", content: "你好", citations: nil))
            $0.messages.append(AgentMessage(id: -2, role: "assistant", content: "", citations: nil))
            $0.isStreaming = true
        }
        cont.yield(SSEFrame(event: "token", data: #"{"type":"token","value":"在"}"#))
        await store.receive(\.streamEvent) { $0.messages[1].content = "在" }
        cont.yield(SSEFrame(event: "done", data: #"{"type":"done","messageId":9,"citations":[]}"#))
        await store.receive(\.streamEvent) { $0.messages[1].id = 9; $0.isStreaming = false }
        cont.finish()
        await store.finish()
    }

    @Test func loadConversationsPopulatesList() async {
        let json = Data(#"[{"id":1,"title":"关于合同的问题"},{"id":2,"title":"报销流程"}]"#.utf8)
        let store = TestStore(initialState: AgentChatFeature.State()) { AgentChatFeature() } withDependencies: {
            $0.agentAPI.request = { _ in json }
        }
        await store.send(.loadConversations) { $0.listPhase = .loading }
        await store.receive(\.conversationsResponse.success) {
            $0.listPhase = .loaded
            $0.conversations = [
                AgentConversation(id: 1, title: "关于合同的问题", messages: nil),
                AgentConversation(id: 2, title: "报销流程", messages: nil),
            ]
        }
    }

    @Test func loadConversationsEmpty() async {
        let store = TestStore(initialState: AgentChatFeature.State()) { AgentChatFeature() } withDependencies: {
            $0.agentAPI.request = { _ in Data("[]".utf8) }
        }
        await store.send(.loadConversations) { $0.listPhase = .loading }
        await store.receive(\.conversationsResponse.success) {
            $0.listPhase = .empty
            $0.conversations = []
        }
    }

    @Test func loadConversationsFailureShowsError() async {
        let store = TestStore(initialState: AgentChatFeature.State()) { AgentChatFeature() } withDependencies: {
            $0.agentAPI.request = { _ in throw AgentAPIError.http(500) }
        }
        await store.send(.loadConversations) { $0.listPhase = .loading }
        await store.receive(\.conversationsResponse.failure) {
            $0.listPhase = .failed
            $0.errorMessage = "会话加载失败,请重试"
        }
    }

    @Test func createAppendsConversation() async {
        let json = Data(#"{"id":7,"title":"新对话"}"#.utf8)
        let store = TestStore(initialState: AgentChatFeature.State()) { AgentChatFeature() } withDependencies: {
            $0.agentAPI.request = { _ in json }
        }
        await store.send(.createTapped)
        await store.receive(\.conversationCreated) {
            $0.conversations = [AgentConversation(id: 7, title: "新对话", messages: nil)]
            $0.listPhase = .loaded
        }
    }

    @Test func streamFailureMarksError() async {
        let (stream, cont) = AsyncThrowingStream<SSEFrame, Error>.makeStream()
        var state = AgentChatFeature.State(); state.currentConversationId = 1; state.input = "你好"
        let store = TestStore(initialState: state) { AgentChatFeature() } withDependencies: {
            $0.agentAPI.stream = { _ in stream }
        }
        await store.send(.sendTapped) {
            $0.input = ""
            $0.messages.append(AgentMessage(id: -1, role: "user", content: "你好", citations: nil))
            $0.messages.append(AgentMessage(id: -2, role: "assistant", content: "", citations: nil))
            $0.isStreaming = true
        }
        cont.finish(throwing: AgentAPIError.http(500))
        await store.receive(\.streamFailed) {
            $0.isStreaming = false
            $0.messages[1].content = "回答生成失败,请重试"
        }
        await store.finish()
    }
}
