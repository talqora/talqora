import Foundation

// 与 proto/ourchat/call/v1/call.proto 及 web 线上 JSON 形状一致;字段名 camelCase。
struct SessionDescriptionDTO: Codable, Equatable, Sendable {
    var type: String   // "offer" | "answer"
    var sdp: String
}

struct IceCandidateDTO: Codable, Equatable, Sendable {
    var candidate: String
    var sdpMlineIndex: Int?   // 注意小写 L,对齐 web 线上字段
    var sdpMid: String?
}

struct IceServerDTO: Codable, Equatable, Sendable {
    var urls: [String]
    var username: String?
    var credential: String?
}

struct CallUserDTO: Codable, Equatable, Sendable {
    var id: Int
    var username: String
    var nickname: String
    var avatar: String
}
