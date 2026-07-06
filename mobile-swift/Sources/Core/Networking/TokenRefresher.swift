import Dependencies
import DependenciesMacros
import Foundation

// 令牌刷新的抽象(依赖倒置)。APIClient 在 401 时用它刷新令牌,而**不直接依赖 authService**
// ——后者在 Services 层,直连会造成 Core→Services 循环。
// 默认实现为「刷新即失败」(fail closed);真实装配(调 authService.refresh/logout)由 App 组合根启动时注入。
@DependencyClient
public struct TokenRefresher: Sendable {
    public var refresh: @Sendable () async throws -> Void
    public var onRefreshFailure: @Sendable () async -> Void
}

extension TokenRefresher: DependencyKey {
    public static let liveValue = TokenRefresher(
        refresh: { throw AuthError.notAuthenticated },
        onRefreshFailure: {}
    )
}

extension DependencyValues {
    public var tokenRefresher: TokenRefresher {
        get { self[TokenRefresher.self] }
        set { self[TokenRefresher.self] = newValue }
    }
}
