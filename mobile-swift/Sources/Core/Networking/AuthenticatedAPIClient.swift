import Dependencies
import Foundation

actor RefreshCoordinator {
    private var inFlight: Task<Void, Error>?

    func run(_ operation: @escaping @Sendable () async throws -> Void) async throws {
        if let task = inFlight {
            try await task.value
            return
        }
        let task = Task { try await operation() }
        inFlight = task
        defer { inFlight = nil }
        try await task.value
    }
}

private func authorize(_ request: APIRequest, using keychain: KeychainStore) -> APIRequest {
    var copy = request
    if let token = try? keychain.load(.accessToken) {
        copy.headers["Authorization"] = "Bearer \(token)"
    }
    return copy
}

func authenticatedPerform(
    _ request: APIRequest,
    base: APIClient,
    keychain: KeychainStore,
    coordinator: RefreshCoordinator,
    refresh: @escaping @Sendable () async throws -> Void,
    onRefreshFailure: @escaping @Sendable () async -> Void
) async throws -> Data {
    do {
        return try await base.perform(authorize(request, using: keychain))
    } catch APIError.unauthorized {
        do {
            try await coordinator.run(refresh)
        } catch {
            await onRefreshFailure()
            throw APIError.unauthorized
        }
        return try await base.perform(authorize(request, using: keychain))
    }
}

extension APIClient {
    static func authenticated(
        base: APIClient,
        keychain: KeychainStore,
        refresh: @escaping @Sendable () async throws -> Void,
        onRefreshFailure: @escaping @Sendable () async -> Void = {}
    ) -> APIClient {
        let coordinator = RefreshCoordinator()
        return APIClient(perform: { request in
            try await authenticatedPerform(
                request,
                base: base,
                keychain: keychain,
                coordinator: coordinator,
                refresh: refresh,
                onRefreshFailure: onRefreshFailure
            )
        })
    }
}

private enum BaseAPIClientKey: DependencyKey {
    static let liveValue = APIClient.live(environment: .current)
}

extension DependencyValues {
    public var baseAPIClient: APIClient {
        get { self[BaseAPIClientKey.self] }
        set { self[BaseAPIClientKey.self] = newValue }
    }
}
