import Dependencies
import DependenciesMacros
import Foundation
import SocketIO

// 待发送的一条消息(上行 message.send)。senderId 由服务端以握手身份为准,故不带。
struct OutgoingMessage: Equatable, Sendable {
    var conversationId: String
    var clientMsgId: String
    var content: String
    var type: String = "text"
    var fileInfo: MessageFileInfo? = nil
}

// 实时通道:一条共享 socket.io 长连接,收发聊天消息。
// connect 幂等(已连则忽略),token 取 Keychain 里的 accessToken,作为握手 auth 上报,
// 与服务端 extractHandshakeToken(handshake.auth.token) 对齐。events() 多订阅者各取一份。
@DependencyClient
struct SocketClient: Sendable {
    var connect: @Sendable () -> Void
    var disconnect: @Sendable () -> Void
    var send: @Sendable (_ message: OutgoingMessage) -> Void
    // 已读上报:单调推进该会话本端 lastReadSeq,服务端据此清未读并同步其它端。
    var reportRead: @Sendable (_ conversationId: String, _ uptoSeq: Int) -> Void
    // 统一事件流:所有服务端实时事件(消息 / 好友请求 / 好友变更 …)都从这一条流出,
    // 由订阅方各取所需。新增事件在 ServerEvent 加 case + 下面 socket.on 注册即可。
    var events: @Sendable () -> AsyncStream<ServerEvent> = { .finished }
}

extension SocketClient: DependencyKey {
    static let liveValue: SocketClient = {
        let connection = SocketConnection(baseURL: URL(string: APIEnvironment.current.baseURLString)!)
        return SocketClient(
            connect: {
                @Dependency(\.keychain) var keychain
                guard let token = (try? keychain.load(.accessToken)) ?? nil else { return }
                Task { await connection.connect(token: token) }
            },
            disconnect: { Task { await connection.disconnect() } },
            send: { message in Task { await connection.send(message) } },
            reportRead: { conversationId, uptoSeq in
                Task { await connection.reportRead(conversationId: conversationId, uptoSeq: uptoSeq) }
            },
            events: {
                @Dependency(\.keychain) var keychain
                let token = (try? keychain.load(.accessToken)) ?? nil
                let (stream, continuation) = AsyncStream<ServerEvent>.makeStream()
                // 先订阅、再连接(同一 Task 顺序 await):保证首个订阅者不漏掉
                // connect 与订阅之间窗口内到达的事件。connect 幂等,后续订阅只订阅。
                Task {
                    await connection.subscribe(continuation)
                    if let token { await connection.connect(token: token) }
                }
                return stream
            }
        )
    }()

    static let previewValue = SocketClient(
        connect: {},
        disconnect: {},
        send: { _ in },
        reportRead: { _, _ in },
        events: { .finished }
    )
}

extension DependencyValues {
    var socketClient: SocketClient {
        get { self[SocketClient.self] }
        set { self[SocketClient.self] = newValue }
    }
}

// 进程内单例连接:非 Sendable 的 SocketManager/SocketIOClient 全程被 actor 隔离持有,
// receiveMessage 回调里同步解析成 Sendable 的 ChatMessage 再扇出给各订阅者。
private actor SocketConnection {
    private let baseURL: URL
    private var manager: SocketManager?
    private var socket: SocketIOClient?
    private var subscribers: [UUID: AsyncStream<ServerEvent>.Continuation] = [:]

    init(baseURL: URL) { self.baseURL = baseURL }

    func connect(token: String) {
        guard socket == nil else { return }
        let manager = SocketManager(
            socketURL: baseURL,
            config: [
                .log(false),
                .forceWebsockets(true),
                .reconnects(true),
                // 服务端 socket 握手鉴权只从 cookie 取 JWT(server utils/socket.ts:
                // parseCookie(handshake.headers.cookie, 'token')),原生端无 cookie,
                // 故把 token 作为 token cookie 放进握手 HTTP 头,否则连接被拒、收不到实时消息。
                .extraHeaders(["Cookie": "token=\(token)"]),
            ]
        )
        let socket = manager.defaultSocket
        // 统一在此注册所有服务端事件,解析后扇出为 ServerEvent(收发口径集中一处)。
        socket.on("receiveMessage") { [weak self] data, _ in
            guard let self, let first = data.first,
                  let message = SocketMessageParser.parse(first) else { return }
            Task { await self.emit(.message(message)) }
        }
        socket.on("receiveFriendReq") { [weak self] data, _ in
            guard let self, let first = data.first,
                  let request = SocketFriendRequestParser.parse(first) else { return }
            Task { await self.emit(.friendRequest(request)) }
        }
        socket.on("friendListChanged") { [weak self] _, _ in
            guard let self else { return }
            Task { await self.emit(.friendListChanged) }
        }
        socket.connect(withPayload: ["token": token])
        self.manager = manager
        self.socket = socket
    }

    func disconnect() {
        socket?.disconnect()
        socket = nil
        manager = nil
    }

    func send(_ message: OutgoingMessage) {
        var payload: [String: Any] = [
            "clientMsgId": message.clientMsgId,
            "conversationId": message.conversationId,
            "content": message.content,
            "type": message.type,
        ]
        if let file = message.fileInfo {
            payload["fileInfo"] = [
                "fileName": file.fileName,
                "fileSize": file.fileSize,
                "fileUrl": file.fileUrl,
            ]
        }
        socket?.emit("message.send", payload)
    }

    func reportRead(conversationId: String, uptoSeq: Int) {
        socket?.emit("read.report", [
            "conversationId": conversationId,
            "uptoSeq": uptoSeq,
        ])
    }

    func subscribe(_ continuation: AsyncStream<ServerEvent>.Continuation) {
        let id = UUID()
        subscribers[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { await self?.unsubscribe(id) }
        }
    }

    private func unsubscribe(_ id: UUID) { subscribers[id] = nil }

    private func emit(_ event: ServerEvent) {
        for continuation in subscribers.values { continuation.yield(event) }
    }
}

// 把 socket.io 投递的 receiveMessage 原始字典解析成领域消息(纯函数,可单测)。
// id/seq 经服务端 BigInt→Number 序列化,这里按 NSNumber/Int/String 多形态兜底取整。
enum SocketMessageParser {
    static func parse(_ raw: Any) -> ChatMessage? {
        guard let dict = raw as? [String: Any],
              let conversationId = dict["conversationId"] as? String,
              let serverId = intValue(dict["id"]) else { return nil }
        return ChatMessage(
            serverId: serverId,
            conversationId: conversationId,
            senderId: intValue(dict["senderId"]) ?? 0,
            seq: intValue(dict["seq"]),
            content: dict["content"] as? String ?? "",
            type: dict["type"] as? String ?? "text",
            timestamp: ConversationAssembler.parseISO(dict["timestamp"] as? String),
            clientMsgId: dict["clientMsgId"] as? String,
            fileInfo: parseFileInfo(dict["fileInfo"])
        )
    }

    static func parseFileInfo(_ any: Any?) -> MessageFileInfo? {
        guard let dict = any as? [String: Any], let fileName = dict["fileName"] as? String else { return nil }
        return MessageFileInfo(
            fileName: fileName,
            fileSize: intValue(dict["fileSize"]) ?? 0,
            fileUrl: dict["fileUrl"] as? String ?? ""
        )
    }

    static func intValue(_ any: Any?) -> Int? {
        switch any {
        case let n as Int: return n
        case let n as NSNumber: return n.intValue
        case let s as String: return Int(s)
        default: return nil
        }
    }
}

// 把 socket.io 投递的 receiveFriendReq 原始字典解析成 FriendRequest(纯函数,可单测)。
// 载荷形状对齐 getFriendReqs 条目:friendId=发起人、username/avatar=其资料、status=pending。
enum SocketFriendRequestParser {
    static func parse(_ raw: Any) -> FriendRequest? {
        guard let dict = raw as? [String: Any],
              let friendId = SocketMessageParser.intValue(dict["friendId"]) else { return nil }
        return FriendRequest(
            peerId: friendId,
            username: dict["username"] as? String ?? String(friendId),
            avatarURL: (dict["avatar"] as? String).flatMap(URL.init(string:)),
            status: FriendRequestStatus(rawValue: dict["status"] as? String ?? "pending") ?? .pending
        )
    }
}
