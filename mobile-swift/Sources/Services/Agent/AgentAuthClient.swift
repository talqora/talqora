import Dependencies
import DependenciesMacros
import Foundation

struct AgentTokenCache: Equatable, Sendable {
    var token: String; var expiresAt: Date
    func isValid(now: Date, skew: TimeInterval) -> Bool { expiresAt.timeIntervalSince(now) > skew }
}

@DependencyClient
struct AgentAuthClient: Sendable {
    var authorize: @Sendable () async throws -> Void
    var ensureToken: @Sendable () async throws -> String
    var isAuthorized: @Sendable () -> Bool = { false }
    var clear: @Sendable () -> Void
}

private let agentAuthorizedFlagKey = "agent.authorized"

extension AgentAuthClient: DependencyKey {
    static let liveValue: AgentAuthClient = {
        let store = AgentTokenStore()
        return AgentAuthClient(
            authorize: {
                _ = try await store.mint()
                UserDefaults.standard.set(true, forKey: agentAuthorizedFlagKey)
            },
            ensureToken: { try await store.ensure() },
            isAuthorized: { UserDefaults.standard.bool(forKey: agentAuthorizedFlagKey) },
            clear: {
                UserDefaults.standard.set(false, forKey: agentAuthorizedFlagKey)
                Task { await store.clearCache() }
            }
        )
    }()
    static let previewValue = AgentAuthClient(
        authorize: {}, ensureToken: { "preview-token" }, isAuthorized: { true }, clear: {}
    )
}
extension DependencyValues {
    var agentAuth: AgentAuthClient {
        get { self[AgentAuthClient.self] }
        set { self[AgentAuthClient.self] = newValue }
    }
}

enum AgentAuthError: Error, Equatable { case noSession, mintFailed }

// 进程内 token 管理:非 Sendable 状态 actor 隔离;mint 用主 App 登录态调 /oauth/agent-token。并发去重。
private actor AgentTokenStore {
    private var cache: AgentTokenCache?
    private var inflight: Task<String, Error>?

    func ensure() async throws -> String {
        if let c = cache, c.isValid(now: Date(), skew: 30) { return c.token }
        if let t = inflight { return try await t.value }
        let task = Task { try await self.mint() }
        inflight = task
        defer { inflight = nil }
        return try await task.value
    }
    func mint() async throws -> String {
        @Dependency(\.keychain) var keychain
        guard let login = (try? keychain.load(.accessToken)) ?? nil else { throw AgentAuthError.noSession }
        var req = URLRequest(url: URL(string: APIEnvironment.current.baseURLString + "/oauth/agent-token")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(login)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw AgentAuthError.mintFailed }
        let r = try JSONDecoder().decode(AgentTokenResponse.self, from: data)
        cache = AgentTokenCache(token: r.accessToken, expiresAt: Date(timeIntervalSinceNow: TimeInterval(r.expiresIn)))
        return r.accessToken
    }
    func clearCache() { cache = nil; inflight = nil }
}
