import Dependencies
import Core
import Contracts
import DependenciesMacros
import Foundation

// 搜索结果:微信「添加朋友」式精确查找(按微信号/手机号/用户名命中单个用户)。
public struct SearchResult: Equatable, Sendable, Identifiable {
    public var id: Int { userId }
    public let userId: Int
    public let username: String
    public let avatarURL: URL?
    public let isFriend: Bool

    public init(userId: Int, username: String, avatarURL: URL?, isFriend: Bool) {
        self.userId = userId
        self.username = username
        self.avatarURL = avatarURL
        self.isFriend = isFriend
    }
}

// 用户搜索:GET /searchUser。命中返回单个用户,未命中返回 nil。
@DependencyClient
public struct SearchClient: Sendable {
    public var search: @Sendable (_ keyword: String) async throws -> SearchResult?
}

extension SearchClient: DependencyKey {
    public static let liveValue = SearchClient(
        search: { keyword in
            @Dependency(\.apiClient) var apiClient
            @Dependency(\.sessionClient) var session
            guard let userId = session.currentUserId() else { throw AuthError.notAuthenticated }
            // /searchUser 无论 success 真假都带 data(已是好友/不存在也走 success:false),
            // 因此手动解信封读 data,而非 sendUnwrapping(后者 success:false 即抛)。
            let envelope = try await apiClient.send(
                APIRequest.get("/user/searchUser", query: [
                    URLQueryItem(name: "keyword", value: keyword),
                    URLQueryItem(name: "userId", value: String(userId)),
                ]),
                decoding: APIResponse<APISearchUserResult>.self
            )
            guard let info = envelope.data?.friendInfo else { return nil }
            return SearchResult(
                userId: Int(info.id),
                username: info.username,
                avatarURL: info.avatar.flatMap(URL.init(string:)),
                isFriend: envelope.data?.isFriend ?? false
            )
        }
    )

    public static let previewValue = SearchClient(
        search: { _ in SearchResult(userId: 1024, username: "duanyuhao", avatarURL: nil, isFriend: false) }
    )
}

extension DependencyValues {
    public var searchClient: SearchClient {
        get { self[SearchClient.self] }
        set { self[SearchClient.self] = newValue }
    }
}
