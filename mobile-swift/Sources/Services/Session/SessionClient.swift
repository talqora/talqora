import Dependencies
import Core
import Contracts
import DependenciesMacros
import Foundation

// 当前会话:从 Keychain 里的 JWT 解出当前用户 id。好友/会话/消息等接口都要带 userId,统一从这里取。
// currentUser 拉取完整资料(username/nickname/avatar):发起/接听通话时,本端资料要随信令带给对端做来电展示,
// JWT 里只有 id,故走 /user/profile 补齐。
@DependencyClient
public struct SessionClient: Sendable {
    public var currentUserId: @Sendable () -> Int?
    public var currentUser: @Sendable () async throws -> CallUserDTO
}

extension SessionClient: DependencyKey {
    public static let liveValue = SessionClient(
        currentUserId: {
            @Dependency(\.keychain) var keychain
            guard let token = (try? keychain.load(.accessToken)) ?? nil else { return nil }
            return JWT.decodeUserId(token)
        },
        currentUser: {
            @Dependency(\.apiClient) var apiClient
            let dto = try await apiClient.sendUnwrapping(APIRequest.get("/user/profile"), as: APIUser.self)
            return CallUserDTO(
                id: Int(dto.id),
                username: dto.username,
                nickname: dto.nickname ?? "",
                avatar: dto.avatar ?? ""
            )
        }
    )
}

extension DependencyValues {
    public var sessionClient: SessionClient {
        get { self[SessionClient.self] }
        set { self[SessionClient.self] = newValue }
    }
}
