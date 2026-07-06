import Foundation

// 与 proto/ourchat/call/v1/call.proto 及 web 线上 JSON 形状一致;字段名 camelCase。
public struct SessionDescriptionDTO: Codable, Equatable, Sendable {
    public var type: String   // "offer" | "answer"
    public var sdp: String

    public init(type: String, sdp: String) {
        self.type = type
        self.sdp = sdp
    }
}

public struct IceCandidateDTO: Codable, Equatable, Sendable {
    public var candidate: String
    public var sdpMlineIndex: Int?   // 注意小写 L,对齐 web 线上字段
    public var sdpMid: String?

    public init(candidate: String, sdpMlineIndex: Int?, sdpMid: String?) {
        self.candidate = candidate
        self.sdpMlineIndex = sdpMlineIndex
        self.sdpMid = sdpMid
    }
}

public struct IceServerDTO: Codable, Equatable, Sendable {
    public var urls: [String]
    public var username: String?
    public var credential: String?

    public init(urls: [String], username: String?, credential: String?) {
        self.urls = urls
        self.username = username
        self.credential = credential
    }
}

public struct CallUserDTO: Codable, Equatable, Sendable {
    public var id: Int
    public var username: String
    public var nickname: String
    public var avatar: String

    public init(id: Int, username: String, nickname: String, avatar: String) {
        self.id = id
        self.username = username
        self.nickname = nickname
        self.avatar = avatar
    }
}
