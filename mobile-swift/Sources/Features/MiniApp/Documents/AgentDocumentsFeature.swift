import ComposableArchitecture
import Services
import Foundation

@Reducer
public struct AgentDocumentsFeature: Sendable {
    enum ListPhase: Equatable { case idle, loading, loaded, empty, failed }

    private enum CancelID { case poll }
    private static let maxPollCount = 12

    @ObservableState
    public struct State: Equatable {
        var documents: [AgentDocument] = []
        var phase: ListPhase = .idle
        var errorMessage: String?
        var isUploading = false
        var pollCount = 0
    }

    public enum Action {
        case onAppear
        case load
        case documentsResponse(Result<[AgentDocument], Error>)
        case uploadPicked(URL)
        case uploadFinished(Result<UploadResult, Error>)
        case pollTick
        case deleteTapped(Int)
    }

    @Dependency(\.agentAPI) var agentAPI
    @Dependency(\.continuousClock) var clock

    public var body: some ReducerOf<Self> {
        Reduce { state, action in
            switch action {

            case .onAppear:
                guard state.phase == .idle else { return .none }
                state.phase = .loading
                return .run { send in
                    await send(.documentsResponse(Result {
                        let data = try await agentAPI.request(.get("/documents"))
                        return try JSONDecoder().decode([AgentDocument].self, from: data)
                    }))
                }

            case .load:
                state.phase = .loading
                return .run { send in
                    await send(.documentsResponse(Result {
                        let data = try await agentAPI.request(.get("/documents"))
                        return try JSONDecoder().decode([AgentDocument].self, from: data)
                    }))
                }

            case let .documentsResponse(.success(list)):
                state.documents = list
                state.phase = list.isEmpty ? .empty : .loaded
                return .none

            case .documentsResponse(.failure):
                state.phase = .failed
                state.errorMessage = "文档加载失败,请重试"
                return .none

            case let .uploadPicked(url):
                guard !state.isUploading else { return .none }
                state.isUploading = true
                let fileName = url.lastPathComponent
                return .run { send in
                    let didAccess = url.startAccessingSecurityScopedResource()
                    defer { if didAccess { url.stopAccessingSecurityScopedResource() } }
                    await send(.uploadFinished(Result {
                        try await agentAPI.upload(url, fileName)
                    }))
                }

            case .uploadFinished(.success):
                state.isUploading = false
                state.pollCount = 0
                return .merge(
                    .send(.load),
                    .run { send in
                        for await _ in clock.timer(interval: .seconds(5)) {
                            await send(.pollTick)
                        }
                    }
                    .cancellable(id: CancelID.poll, cancelInFlight: true)
                )

            case .uploadFinished(.failure):
                state.isUploading = false
                state.errorMessage = "上传失败,请重试"
                return .none

            case .pollTick:
                state.pollCount += 1
                let allSettled = state.documents.allSatisfy { $0.status == "ready" || $0.status == "failed" }
                guard !allSettled, state.pollCount < AgentDocumentsFeature.maxPollCount else {
                    return .cancel(id: CancelID.poll)
                }
                return .send(.load)

            case let .deleteTapped(id):
                state.documents.removeAll { $0.id == id }
                if state.documents.isEmpty { state.phase = .empty }
                return .run { _ in
                    _ = try? await agentAPI.request(.delete("/documents/\(id)"))
                }
            }
        }
    }
}
