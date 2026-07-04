import Dependencies
import DependenciesMacros
import Foundation

// /api/turn-credentials 返回的直接 JSON 形状(无 success/data 信封)。
struct TurnCredentialsResponse: Codable, Equatable, Sendable {
    var iceServers: [IceServerDTO]
    var ttl: Int
}

@DependencyClient
struct TurnCredentialsClient: Sendable {
    var fetch: @Sendable () async throws -> [IceServerDTO]
}

extension TurnCredentialsClient: DependencyKey {
    static let liveValue = TurnCredentialsClient(
        fetch: {
            @Dependency(\.apiClient) var apiClient
            let response = try await apiClient.send(
                .get("/api/turn-credentials"),
                decoding: TurnCredentialsResponse.self
            )
            return response.iceServers
        }
    )

    static let previewValue = TurnCredentialsClient(fetch: { [] })
}

extension DependencyValues {
    var turnCredentials: TurnCredentialsClient {
        get { self[TurnCredentialsClient.self] }
        set { self[TurnCredentialsClient.self] = newValue }
    }
}
