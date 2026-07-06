import Foundation

// 文件/图片消息附带的文件信息(线上 camelCase:fileName/fileSize/fileUrl)。
public struct MessageFileInfo: Equatable, Sendable {
    public var fileName: String
    public var fileSize: Int
    public var fileUrl: String

    public init(fileName: String, fileSize: Int, fileUrl: String) {
        self.fileName = fileName
        self.fileSize = fileSize
        self.fileUrl = fileUrl
    }
}

// 一条聊天消息(GET /user/messages 走 prisma,camelCase)。是否"我发的"由上层比对 currentUserId 决定。
public struct ChatMessage: Identifiable, Equatable, Sendable {
    // 服务端 message.id;乐观发送(尚无回执)时为 0,收到 receiveMessage/ack 后回填真值。
    public let serverId: Int
    public let conversationId: String
    public let senderId: Int
    public let seq: Int?
    public let content: String
    public let type: String
    public let timestamp: Date?
    // 客户端幂等键:乐观消息与服务端回显共用同键,用于去重/替换。
    public let clientMsgId: String?
    // type=file 时携带文件名/大小/地址,供气泡渲染。
    public var fileInfo: MessageFileInfo?

    public init(
        serverId: Int,
        conversationId: String,
        senderId: Int,
        seq: Int?,
        content: String,
        type: String,
        timestamp: Date?,
        clientMsgId: String?,
        fileInfo: MessageFileInfo? = nil
    ) {
        self.serverId = serverId
        self.conversationId = conversationId
        self.senderId = senderId
        self.seq = seq
        self.content = content
        self.type = type
        self.timestamp = timestamp
        self.clientMsgId = clientMsgId
        self.fileInfo = fileInfo
    }

    // 列表稳定标识:优先 clientMsgId(乐观消息与其回显同键,替换不抖动),否则退回服务端 id。
    public var id: String { clientMsgId ?? "srv-\(serverId)" }
}
