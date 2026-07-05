import ComposableArchitecture
import Foundation
import Testing
@testable import OurChat

@MainActor
struct AgentTasksFeatureTests {
    @Test func submitStreamsEventsThenFinalAnswer() async {
        let (stream, cont) = AsyncThrowingStream<SSEFrame, Error>.makeStream()
        let store = TestStore(initialState: AgentTasksFeature.State(input: "帮我查违约金上限")) {
            AgentTasksFeature()
        } withDependencies: {
            $0.agentAPI.request = { _ in Data(#"{"runId":"run_1"}"#.utf8) }
            $0.agentAPI.stream = { _ in stream }
        }

        await store.send(.submitTapped) { $0.phase = .submitting }
        await store.receive(\.runStarted) {
            $0.runId = "run_1"
            $0.phase = .running
            $0.input = ""
        }

        let toolCalled = SSEFrame(event: "tool_called", data: #"{"payload":{"name":"search_kb","args":{"q":"违约金"}}}"#)
        cont.yield(toolCalled)
        await store.receive(\.runEvent) {
            $0.events = [RunEvent(name: "tool_called", data: toolCalled.data)]
        }

        let finalAnswer = SSEFrame(event: "final_answer", data: #"{"payload":{"content":"不超过实际损失的 30%。"}}"#)
        cont.yield(finalAnswer)
        await store.receive(\.runEvent) {
            $0.events = [
                RunEvent(name: "tool_called", data: toolCalled.data),
                RunEvent(name: "final_answer", data: finalAnswer.data),
            ]
            $0.finalAnswer = "不超过实际损失的 30%。"
            $0.phase = .finished
        }

        cont.finish()
        await store.finish()
    }

    @Test func submitFailureShowsError() async {
        let store = TestStore(initialState: AgentTasksFeature.State(input: "做点什么")) {
            AgentTasksFeature()
        } withDependencies: {
            $0.agentAPI.request = { _ in throw AgentAPIError.http(500) }
        }
        await store.send(.submitTapped) { $0.phase = .submitting }
        await store.receive(\.submitFailed) {
            $0.phase = .failed
            $0.errorMessage = "任务提交失败,请重试"
        }
    }

    @Test func runFailedEventMarksFailure() async {
        let (stream, cont) = AsyncThrowingStream<SSEFrame, Error>.makeStream()
        let store = TestStore(initialState: AgentTasksFeature.State(input: "做点什么")) {
            AgentTasksFeature()
        } withDependencies: {
            $0.agentAPI.request = { _ in Data(#"{"runId":"run_2"}"#.utf8) }
            $0.agentAPI.stream = { _ in stream }
        }
        await store.send(.submitTapped) { $0.phase = .submitting }
        await store.receive(\.runStarted) {
            $0.runId = "run_2"
            $0.phase = .running
            $0.input = ""
        }
        let failed = SSEFrame(event: "run_failed", data: #"{"payload":{"error":"工具超时"}}"#)
        cont.yield(failed)
        await store.receive(\.runEvent) {
            $0.events = [RunEvent(name: "run_failed", data: failed.data)]
            $0.errorMessage = "工具超时"
            $0.phase = .failed
        }
        cont.finish()
        await store.finish()
    }

    @Test func emptyInputDoesNothing() async {
        let store = TestStore(initialState: AgentTasksFeature.State(input: "   ")) {
            AgentTasksFeature()
        }
        await store.send(.submitTapped)
    }
}
