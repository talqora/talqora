import Dependencies
import Core
import Contracts
import DependenciesMacros
import Foundation

// 一条好友关系/请求(friendships 表里「我 → 对方」那一行)。peer 即对方。
public struct FriendRequest: Equatable, Sendable, Identifiable {
    public var id: Int { peerId }
    public let peerId: Int
    public let username: String
    public let avatarURL: URL?
    public let status: FriendRequestStatus

    public init(peerId: Int, username: String, avatarURL: URL?, status: FriendRequestStatus) {
        self.peerId = peerId
        self.username = username
        self.avatarURL = avatarURL
        self.status = status
    }
}

// 与服务端 FriendshipStatus 对齐:sent=我发出待对方验证,pending=对方发来待我验证,accepted=已是好友。
public enum FriendRequestStatus: String, Equatable, Sendable {
    case sent
    case pending
    case accepted
    case blocked
}

// 好友请求:发起 / 拉取我收到与发出的请求 / 回复(接受或拒绝)。
@DependencyClient
public struct FriendRequestClient: Sendable {
    public var send: @Sendable (_ friendId: Int) async throws -> Void
    public var list: @Sendable () async throws -> [FriendRequest]
    public var reply: @Sendable (_ friendId: Int, _ accepted: Bool) async throws -> Void
}

extension FriendRequestClient: DependencyKey {
    public static let liveValue = FriendRequestClient(
        send: { friendId in
            @Dependency(\.apiClient) var apiClient
            @Dependency(\.sessionClient) var session
            guard let userId = session.currentUserId() else { throw AuthError.notAuthenticated }
            let request = try APIRequest.put("/user/addFriend", json: ["userId": userId, "friendId": friendId])
            try await ensureSuccess(apiClient, request)
        },
        list: {
            @Dependency(\.apiClient) var apiClient
            @Dependency(\.sessionClient) var session
            guard let userId = session.currentUserId() else { throw AuthError.notAuthenticated }
            let rows = try await apiClient.sendUnwrapping(
                APIRequest.get("/user/getFriendReqs", query: [URLQueryItem(name: "userId", value: String(userId))]),
                as: [String: APIFriendRequest].self
            )
            return rows.values
                .sorted { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }
                .map {
                    FriendRequest(
                        peerId: Int($0.friendId),
                        username: $0.username ?? String($0.friendId),
                        avatarURL: $0.avatar.flatMap(URL.init(string:)),
                        status: FriendRequestStatus(rawValue: $0.status) ?? .pending
                    )
                }
        },
        reply: { friendId, accepted in
            @Dependency(\.apiClient) var apiClient
            @Dependency(\.sessionClient) var session
            guard let userId = session.currentUserId() else { throw AuthError.notAuthenticated }
            let request = try APIRequest.put("/user/replyFriendReq", json: [
                "userId": String(userId),
                "friendId": String(friendId),
                "status": accepted ? "accepted" : "blocked",
            ])
            try await ensureSuccess(apiClient, request)
        }
    )

    public static let previewValue = FriendRequestClient(
        send: { _ in },
        list: {
            [
                FriendRequest(peerId: 2, username: "段宇皓", avatarURL: nil, status: .pending),
                FriendRequest(peerId: 3, username: "王博扬", avatarURL: nil, status: .sent),
            ]
        },
        reply: { _, _ in }
    )
}

// 写操作:解信封,success=false 即抛(带服务端 message)。data 形态不定,用空结构体吞掉。
private func ensureSuccess(_ apiClient: APIClient, _ request: APIRequest) async throws {
    struct Empty: Decodable {}
    let envelope = try await apiClient.send(request, decoding: APIResponse<Empty>.self)
    guard envelope.success else { throw APIError.server(message: envelope.message ?? "操作失败") }
}

extension DependencyValues {
    public var friendRequestClient: FriendRequestClient {
        get { self[FriendRequestClient.self] }
        set { self[FriendRequestClient.self] = newValue }
    }
}
