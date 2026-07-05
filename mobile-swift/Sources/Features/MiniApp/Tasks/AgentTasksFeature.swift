import ComposableArchitecture
import Foundation

@Reducer
struct AgentTasksFeature {
    enum RunPhase: Equatable { case idle, submitting, running, finished, failed }

    @ObservableState
    struct State: Equatable {
        var input: String = ""
        var phase: RunPhase = .idle
        var runId: String?
        var events: [RunEvent] = []
        var finalAnswer: String?
        var errorMessage: String?
    }

    enum Action: BindableAction {
        case binding(BindingAction<State>)
        case submitTapped
        case runStarted(String)
        case submitFailed
        case runEvent(RunEvent)
        case streamFailed
    }

    @Dependency(\.agentAPI) var agentAPI

    private enum CancelID { case stream }

    var body: some ReducerOf<Self> {
        BindingReducer()
        Reduce { state, action in
            switch action {
            case .binding:
                return .none

            case .submitTapped:
                let task = state.input.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !task.isEmpty, state.phase != .submitting, state.phase != .running else { return .none }
                state.phase = .submitting
                state.events = []
                state.finalAnswer = nil
                state.errorMessage = nil
                let body = try? JSONSerialization.data(withJSONObject: ["task": task])
                return .run { send in
                    let data = try await agentAPI.request(.post("/agent/tasks", body))
                    let result = try JSONDecoder().decode(RunIdResult.self, from: data)
                    await send(.runStarted(result.runId))
                } catch: { _, send in
                    await send(.submitFailed)
                }

            case let .runStarted(runId):
                state.runId = runId
                state.phase = .running
                state.input = ""
                return .run { send in
                    for try await frame in agentAPI.stream(.get("/runs/\(runId)/stream")) {
                        await send(.runEvent(RunEvent(name: frame.event, data: frame.data)))
                    }
                } catch: { _, send in
                    await send(.streamFailed)
                }
                .cancellable(id: CancelID.stream, cancelInFlight: true)

            case .submitFailed:
                state.phase = .failed
                state.errorMessage = "任务提交失败,请重试"
                return .none

            case let .runEvent(event):
                state.events.append(event)
                switch event.name {
                case "final_answer", "run_completed":
                    if let content = event.runPayloadContent { state.finalAnswer = content }
                    state.phase = .finished
                    return .cancel(id: CancelID.stream)
                case "run_failed":
                    state.errorMessage = event.runPayloadError ?? "任务执行失败,请重试"
                    state.phase = .failed
                    return .cancel(id: CancelID.stream)
                default:
                    return .none
                }

            case .streamFailed:
                // 已到终态(收到过 final_answer/run_failed)就不覆盖为连接错误。
                guard state.phase == .running else { return .none }
                state.phase = .failed
                state.errorMessage = "连接中断,请重试"
                return .cancel(id: CancelID.stream)
            }
        }
    }
}

// run SSE 的 data 是整条 run_event 记录:{ eventType, sequenceNo, payload:{...}, ... }。
// 真实 payload:tool_called{name,args} · tool_result{name,result} · final_answer{content} · run_failed{error}。
extension RunEvent {
    var runPayloadContent: String? { payloadString("content") }
    var runPayloadError: String? { payloadString("error") }
    var toolName: String? { payloadString("name") }
    var toolResult: String? { payloadString("result") }
    var toolArgsPretty: String? {
        guard let args = payloadObject?["args"] else { return nil }
        guard JSONSerialization.isValidJSONObject(args),
              let data = try? JSONSerialization.data(withJSONObject: args, options: [.prettyPrinted, .sortedKeys]),
              let str = String(data: data, encoding: .utf8)
        else { return String(describing: args) }
        return str
    }

    private var payloadObject: [String: Any]? {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(data.utf8)),
              let root = obj as? [String: Any]
        else { return nil }
        return root["payload"] as? [String: Any]
    }

    private func payloadString(_ key: String) -> String? {
        payloadObject?[key] as? String
    }
}
