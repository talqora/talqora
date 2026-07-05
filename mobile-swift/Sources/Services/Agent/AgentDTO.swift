import Foundation

struct AgentTokenResponse: Codable, Equatable, Sendable {
    var accessToken: String, tokenType: String, expiresIn: Int
    enum CodingKeys: String, CodingKey { case accessToken = "access_token", tokenType = "token_type", expiresIn = "expires_in" }
}
struct AgentUser: Codable, Equatable, Sendable { var id: Int; var username: String; var displayName: String? }
struct Citation: Codable, Equatable, Sendable { var chunkId: Int; var documentId: Int; var score: Double }
struct AgentMessage: Codable, Equatable, Sendable, Identifiable {
    var id: Int; var role: String; var content: String; var citations: [Citation]?
}
struct AgentConversation: Codable, Equatable, Sendable, Identifiable {
    var id: Int; var title: String; var messages: [AgentMessage]?
}
struct AgentDocument: Codable, Equatable, Sendable, Identifiable {
    var id: Int; var filename: String; var size: Int?; var chunkCount: Int?; var status: String; var error: String?
}
struct UploadResult: Codable, Equatable, Sendable { var documentId: Int; var runId: String }
struct RunIdResult: Codable, Equatable, Sendable { var runId: String }

// 对话 SSE:token 增量 / done(带引用)/ error
enum ChatStreamEvent: Equatable, Sendable {
    case token(String), done(messageId: Int, citations: [Citation]), error(String)
    static func decode(event: String, data: String) throws -> ChatStreamEvent {
        let d = Data(data.utf8)
        switch event {
        case "token":
            struct T: Decodable { let value: String }
            return .token(try JSONDecoder().decode(T.self, from: d).value)
        case "done":
            struct De: Decodable { let messageId: Int; let citations: [Citation]? }
            let x = try JSONDecoder().decode(De.self, from: d); return .done(messageId: x.messageId, citations: x.citations ?? [])
        default:
            struct E: Decodable { let message: String? }
            return .error((try? JSONDecoder().decode(E.self, from: d).message) ?? "生成失败")
        }
    }
}

// 任务/文档 run SSE:够用即可(名称 + 原始 data),UI 侧再细分。
struct RunEvent: Equatable, Sendable { var name: String; var data: String }
