import Dependencies
import Core
import Contracts
import Models
import DependenciesMacros
import Foundation

// 会话数据源。liveValue 聚合三个真实接口(userConversations + conversations + lastMessages)+ 好友资料
// 解析单聊标题/头像;previewValue 用样本供 SwiftUI 预览离线渲染。
@DependencyClient
public struct ChatClient: Sendable {
    public var conversations: @Sendable () async throws -> [Conversation]
    public var otherDeviceCount: @Sendable () async throws -> Int = { 0 }
    public var messages: @Sendable (_ conversationId: String) async throws -> [ChatMessage]
}

// 线上类型来自 openapi.yaml 生成(APIUserConversation/APIConversation/APIMessagePreview/APIMessage)。
// APIMessage → 领域 ChatMessage 的映射(int64→Int、_type→type、fileInfo 取非空)。
private func toChatMessage(_ m: APIMessage) -> ChatMessage {
    ChatMessage(
        serverId: Int(m.id),
        conversationId: m.conversationId,
        senderId: Int(m.senderId),
        seq: m.seq.map(Int.init),
        content: m.content,
        type: m._type,
        timestamp: m.timestamp,
        clientMsgId: m.clientMsgId,
        fileInfo: m.fileInfo.flatMap(toMessageFileInfo)
    )
}

private func toMessageFileInfo(_ f: APIFileInfo) -> MessageFileInfo? {
    guard let name = f.fileName else { return nil } // 非文件消息下发空对象 {},fileName 缺失即视为无文件
    return MessageFileInfo(fileName: name, fileSize: Int(f.fileSize ?? 0), fileUrl: f.fileUrl ?? "")
}

extension ChatClient: DependencyKey {
    public static let liveValue = ChatClient(
        conversations: {
            @Dependency(\.apiClient) var apiClient
            @Dependency(\.sessionClient) var session
            @Dependency(\.contactsClient) var contactsClient
            guard let userId = session.currentUserId() else { throw AuthError.notAuthenticated }
            // 绑成本地 Sendable 值,供下面并发 async let 安全捕获(避免直接送 @Dependency 访问器)。
            let client = apiClient
            let contacts = contactsClient

            let userConvs = try await client.sendUnwrapping(
                APIRequest.get("/user/userConversations", query: [URLQueryItem(name: "userId", value: String(userId))]),
                as: [APIUserConversation].self
            )
            let ids = userConvs.map(\.conversationId)
            guard !ids.isEmpty else { return [] }
            let idsParam = jsonArray(ids)

            async let metasTask = client.sendUnwrapping(
                APIRequest.get("/user/conversations", query: [URLQueryItem(name: "userConversationIds", value: idsParam)]),
                as: [String: APIConversation].self
            )
            async let lastsTask = client.sendUnwrapping(
                APIRequest.get("/user/lastMessages", query: [URLQueryItem(name: "userConversationIds", value: idsParam)]),
                as: [String: APIMessagePreview].self
            )
            async let friendsTask = contacts.contacts()
            let (metas, lasts, friends) = try await (metasTask, lastsTask, friendsTask)

            let friendIndex = Dictionary(friends.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            return ConversationAssembler.assemble(
                userConvs: userConvs.map {
                    .init(conversationId: $0.conversationId, unreadCount: $0.unreadCount ?? 0, isMuted: $0.isMuted ?? false, lastActivity: $0.lastActivity)
                },
                metas: metas.mapValues { .init(convType: $0.convType, title: $0.title, avatar: $0.avatar) },
                lasts: lasts.mapValues { .init(content: $0.content, type: $0._type, timestamp: $0.timestamp) },
                friends: friendIndex,
                myUserId: userId
            )
        },
        otherDeviceCount: { 0 }, // 暂无对应 REST 来源,隐藏"已登录N台设备"条
        messages: { conversationId in
            @Dependency(\.apiClient) var apiClient
            let messages = try await apiClient.sendUnwrapping(
                APIRequest.get("/user/messages", query: [URLQueryItem(name: "conversationId", value: conversationId)]),
                as: [APIMessage].self
            )
            return messages.map(toChatMessage)
        }
    )

    public static let previewValue = ChatClient(
        conversations: { ConversationSamples.all },
        otherDeviceCount: { 2 },
        messages: { _ in MessageSamples.all }
    )
}

extension DependencyValues {
    public var chatClient: ChatClient {
        get { self[ChatClient.self] }
        set { self[ChatClient.self] = newValue }
    }
}

private func jsonArray(_ values: [String]) -> String {
    (try? String(decoding: JSONEncoder().encode(values), as: UTF8.self)) ?? "[]"
}

// 聚合逻辑抽成纯函数,便于单测(给定三接口数据 + 好友 → 期望会话行)。
public enum ConversationAssembler {
    struct UserConv: Equatable { var conversationId: String; var unreadCount: Int; var isMuted: Bool; var lastActivity: Date? }
    struct Meta: Equatable { var convType: String?; var title: String?; var avatar: String? }
    struct Last: Equatable { var content: String?; var type: String?; var timestamp: Date? }

    static func assemble(
        userConvs: [UserConv],
        metas: [String: Meta],
        lasts: [String: Last],
        friends: [String: Contact],
        myUserId: Int,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [Conversation] {
        userConvs.map { uc in
            let meta = metas[uc.conversationId]
            let last = lasts[uc.conversationId]
            let isGroup = meta?.convType == "group" || uc.conversationId.hasPrefix("group_")
            let (title, avatarURL) = resolveTitleAvatar(
                conversationId: uc.conversationId, isGroup: isGroup, meta: meta, friends: friends, myUserId: myUserId
            )
            let preview = MessagePreview.text(content: last?.content ?? "", type: last?.type ?? "text")
            let date = last?.timestamp ?? uc.lastActivity
            let timeText = date.map { RelativeTime.label(from: $0, now: now, calendar: calendar) } ?? ""
            return Conversation(
                id: uc.conversationId,
                title: title,
                preview: preview,
                timeText: timeText,
                unreadCount: uc.isMuted ? 0 : uc.unreadCount,
                hasRedDot: uc.isMuted && uc.unreadCount > 0,
                isMuted: uc.isMuted,
                avatarURL: avatarURL,
                isGroup: isGroup
            )
        }
    }

    private static func resolveTitleAvatar(
        conversationId: String, isGroup: Bool, meta: Meta?, friends: [String: Contact], myUserId: Int
    ) -> (String, URL?) {
        if isGroup {
            return (meta?.title?.nonEmpty ?? "群聊", meta?.avatar.flatMap(URL.init(string:)))
        }
        // 单聊 id 形如 single_<a>_<b>,标题/头像取"另一方"好友资料。
        let parts = conversationId.split(separator: "_")
        let otherId: String? = parts.count == 3
            ? (parts[1] == String(myUserId) ? String(parts[2]) : String(parts[1]))
            : nil
        if let otherId, let friend = friends[otherId] {
            return (friend.name, friend.avatarURL)
        }
        return (otherId ?? conversationId, nil)
    }

    static func parseISO(_ string: String?) -> Date? {
        guard let string else { return nil }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: string) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: string)
    }
}

private extension String {
    public var nonEmpty: String? { isEmpty ? nil : self }
}

// SwiftUI 预览用样本(离线零网络)。
public enum ConversationSamples {
    public static let all: [Conversation] = [
        Conversation(id: "g1", title: "哥布林巢穴", preview: "王博扬: [动画表情]", timeText: "01:55", hasRedDot: true, isMuted: true, isGroup: true),
        Conversation(id: "single_1_2", title: "段宇皓", preview: "OK", timeText: "昨天"),
        Conversation(id: "ft", title: "文件传输助手", preview: "[文件]", timeText: "昨天", systemTile: .fileTransfer),
        Conversation(id: "g2", title: "线性代数软件工程1-4班", preview: "谢谢", timeText: "6月18日", isMuted: true, isGroup: true),
    ]
}

// SwiftUI 预览用消息样本。
public enum MessageSamples {
    public static let all: [ChatMessage] = [
        ChatMessage(serverId: 1, conversationId: "single_1_2", senderId: 2, seq: 1, content: "在吗?", type: "text", timestamp: nil, clientMsgId: nil),
        ChatMessage(serverId: 2, conversationId: "single_1_2", senderId: 1, seq: 2, content: "在的", type: "text", timestamp: nil, clientMsgId: nil),
        ChatMessage(serverId: 3, conversationId: "single_1_2", senderId: 2, seq: 3, content: "OK", type: "text", timestamp: nil, clientMsgId: nil),
    ]
}
