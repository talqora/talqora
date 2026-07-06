import Foundation

// 会话列表项(微信首页一行)。UI 无关:头像用 url 或系统图标块,时间已格式化为展示串。
public struct Conversation: Identifiable, Equatable, Sendable {
    public let id: String
    public var title: String
    public var preview: String // 最后一条消息预览,可含 "[12条]"/"昵称: " 等前缀
    public var timeText: String // 右上角时间展示串:"01:55" / "昨天" / "周二" / "6月18日"
    public var unreadCount: Int
    public var hasRedDot: Bool // 免打扰会话用小红点而非数字角标
    public var isMuted: Bool
    public var isPinned: Bool
    public var avatarURL: URL?
    public var isGroup: Bool
    public var systemTile: SystemTile? // 非 nil 时用纯色图标块(如文件传输助手)

    public init(
        id: String,
        title: String,
        preview: String,
        timeText: String,
        unreadCount: Int = 0,
        hasRedDot: Bool = false,
        isMuted: Bool = false,
        isPinned: Bool = false,
        avatarURL: URL? = nil,
        isGroup: Bool = false,
        systemTile: SystemTile? = nil
    ) {
        self.id = id
        self.title = title
        self.preview = preview
        self.timeText = timeText
        self.unreadCount = unreadCount
        self.hasRedDot = hasRedDot
        self.isMuted = isMuted
        self.isPinned = isPinned
        self.avatarURL = avatarURL
        self.isGroup = isGroup
        self.systemTile = systemTile
    }
}

// 系统会话的图标块样式(微信用品牌色方块 + 图标,而非头像)。
public enum SystemTile: Equatable, Sendable {
    case fileTransfer
}
