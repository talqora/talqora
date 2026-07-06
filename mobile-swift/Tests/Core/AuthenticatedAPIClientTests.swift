import Foundation
@testable import Core
import Testing
@testable import OurChat

private final class Box<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    init(_ value: Value) {
        self.value = value
    }

    func withLock<Result>(_ body: (inout Value) -> Result) -> Result {
        lock.lock()
        defer { lock.unlock() }
        return body(&value)
    }
}

private final class Gate: @unchecked Sendable {
    private let lock = NSLock()
    private var isOpen = false
    private var continuations: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        await withCheckedContinuation { continuation in
            lock.lock()
            if isOpen {
                lock.unlock()
                continuation.resume()
            } else {
                continuations.append(continuation)
                lock.unlock()
            }
        }
    }

    func open() {
        lock.lock()
        isOpen = true
        let pending = continuations
        continuations.removeAll()
        lock.unlock()
        for continuation in pending {
            continuation.resume()
        }
    }
}

struct AuthenticatedAPIClientTests {
    @Test
    func injectsBearerTokenFromKeychain() async throws {
        let keychain = KeychainStore.inMemory()
        try keychain.save("at-1", .accessToken)
        let captured = Box<String?>(nil)
        let base = APIClient(perform: { request in
            captured.withLock { $0 = request.headers["Authorization"] }
            return Data()
        })

        let client = APIClient.authenticated(base: base, keychain: keychain, refresh: {})
        _ = try await client.perform(.get("/x"))

        #expect(captured.withLock { $0 } == "Bearer at-1")
    }

    @Test
    func retriesOnceWithNewTokenAfterRefresh() async throws {
        let keychain = KeychainStore.inMemory()
        try keychain.save("old", .accessToken)
        let calls = Box(0)
        let refreshCount = Box(0)
        let base = APIClient(perform: { request in
            let attempt = calls.withLock { $0 += 1; return $0 }
            if attempt == 1 {
                throw APIError.unauthorized
            }
            return Data((request.headers["Authorization"] ?? "").utf8)
        })
        let refresh: @Sendable () async throws -> Void = {
            refreshCount.withLock { $0 += 1 }
            try keychain.save("new", .accessToken)
        }

        let client = APIClient.authenticated(base: base, keychain: keychain, refresh: refresh)
        let data = try await client.perform(.get("/x"))

        #expect(calls.withLock { $0 } == 2)
        #expect(refreshCount.withLock { $0 } == 1)
        #expect(String(decoding: data, as: UTF8.self) == "Bearer new")
    }

    @Test
    func coordinatorCoalescesConcurrentRunsIntoOne() async throws {
        let coordinator = RefreshCoordinator()
        let opCount = Box(0)
        let gate = Gate()
        let operation: @Sendable () async throws -> Void = {
            opCount.withLock { $0 += 1 }
            await gate.wait()
        }

        await withTaskGroup(of: Void.self) { group in
            for _ in 0 ..< 10 {
                group.addTask {
                    try? await coordinator.run(operation)
                }
            }
            // The first run parks its operation on the gate, so inFlight stays set
            // for the whole window — every other caller entering here coalesces onto
            // the same in-flight task rather than starting a new operation.
            try? await Task.sleep(for: .milliseconds(50))
            gate.open()
        }

        #expect(opCount.withLock { $0 } == 1)
    }

    @Test
    func refreshFailureTriggersLogoutAndThrows() async {
        let keychain = KeychainStore.inMemory()
        let loggedOut = Box(false)
        let base = APIClient(perform: { _ in throw APIError.unauthorized })
        let refresh: @Sendable () async throws -> Void = { throw AuthError.notAuthenticated }
        let onFailure: @Sendable () async -> Void = { loggedOut.withLock { $0 = true } }

        let client = APIClient.authenticated(
            base: base,
            keychain: keychain,
            refresh: refresh,
            onRefreshFailure: onFailure
        )

        await #expect(throws: APIError.unauthorized) {
            _ = try await client.perform(.get("/x"))
        }
        #expect(loggedOut.withLock { $0 } == true)
    }
}
