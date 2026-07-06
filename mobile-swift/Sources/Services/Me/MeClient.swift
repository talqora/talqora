import Dependencies
import Models
import Core
import Contracts
import DependenciesMacros
import Foundation

// 「我」页数据源:GET /user/profile 取当前用户资料,好友数复用 ContactsClient。
// previewValue 用样本供 SwiftUI 预览离线渲染。
@DependencyClient
public struct MeClient: Sendable {
    public var profile: @Sendable () async throws -> MeProfile
    // 更新头像:POST /user/update(字段白名单含 avatar),鉴权取当前用户 id。
    public var updateAvatar: @Sendable (_ url: URL) async throws -> Void
    // 更新名字(昵称):POST /user/update(白名单含 nickname)。
    public var updateName: @Sendable (_ nickname: String) async throws -> Void
}

extension MeClient: DependencyKey {
    public static let liveValue = MeClient(
        profile: {
            @Dependency(\.apiClient) var apiClient
            @Dependency(\.contactsClient) var contactsClient
            // 绑成本地 Sendable 值,供并发 async let 安全捕获。
            let client = apiClient
            let contacts = contactsClient

            async let profileTask = client.sendUnwrapping(APIRequest.get("/user/profile"), as: APIUser.self)
            async let friendsTask = contacts.contacts()
            let (dto, friends) = try await (profileTask, friendsTask)

            let nickname = dto.nickname ?? ""
            return MeProfile(
                name: nickname.isEmpty ? dto.username : nickname,
                wxid: String(dto.id), // 微信号即数字 id
                avatarURL: dto.avatar.flatMap(URL.init(string:)),
                friendCount: friends.count
            )
        },
        updateAvatar: { url in
            @Dependency(\.apiClient) var apiClient
            @Dependency(\.sessionClient) var session
            guard let userId = session.currentUserId() else { throw AuthError.notAuthenticated }
            struct UpdateAck: Decodable {} // /user/update 成功回 { message },用空结构忽略
            let request = try APIRequest.post("/user/update", json: ["id": String(userId), "avatar": url.absoluteString])
            _ = try await apiClient.send(request, decoding: UpdateAck.self)
        },
        updateName: { nickname in
            @Dependency(\.apiClient) var apiClient
            @Dependency(\.sessionClient) var session
            guard let userId = session.currentUserId() else { throw AuthError.notAuthenticated }
            struct UpdateAck: Decodable {}
            let request = try APIRequest.post("/user/update", json: ["id": String(userId), "nickname": nickname])
            _ = try await apiClient.send(request, decoding: UpdateAck.self)
        }
    )

    public static let previewValue = MeClient(
        profile: { .sample },
        updateAvatar: { _ in },
        updateName: { _ in }
    )
}

extension DependencyValues {
    public var meClient: MeClient {
        get { self[MeClient.self] }
        set { self[MeClient.self] = newValue }
    }
}
