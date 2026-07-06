import Dependencies
import Core
import DependenciesMacros
import Foundation

// /api/turn-credentials 返回的直接 JSON 形状(无 success/data 信封)。
public struct TurnCredentialsResponse: Codable, Equatable, Sendable {
    public var iceServers: [IceServerDTO]
    public var ttl: Int
}

@DependencyClient
public struct TurnCredentialsClient: Sendable {
    public var fetch: @Sendable () async throws -> [IceServerDTO]
}

extension TurnCredentialsClient: DependencyKey {
    public static let liveValue = TurnCredentialsClient(
        fetch: {
            @Dependency(\.apiClient) var apiClient
            let response = try await apiClient.send(
                .get("/api/turn-credentials"),
                decoding: TurnCredentialsResponse.self
            )
            return response.iceServers
        }
    )

    public static let previewValue = TurnCredentialsClient(fetch: { [] })
}

extension DependencyValues {
    public var turnCredentials: TurnCredentialsClient {
        get { self[TurnCredentialsClient.self] }
        set { self[TurnCredentialsClient.self] = newValue }
    }
}
