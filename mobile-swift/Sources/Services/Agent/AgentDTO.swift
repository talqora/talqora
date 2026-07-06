import Foundation

public struct AgentTokenResponse: Codable, Equatable, Sendable {
    public var accessToken: String
    public var tokenType: String
    public var expiresIn: Int
    enum CodingKeys: String, CodingKey { case accessToken = "access_token", tokenType = "token_type", expiresIn = "expires_in" }
    public init(accessToken: String, tokenType: String, expiresIn: Int) {
        self.accessToken = accessToken; self.tokenType = tokenType; self.expiresIn = expiresIn
    }
}

public struct AgentUser: Codable, Equatable, Sendable {
    public var id: Int
    public var username: String
    public var displayName: String?
    public init(id: Int, username: String, displayName: String?) {
        self.id = id; self.username = username; self.displayName = displayName
    }
}

public struct Citation: Codable, Equatable, Sendable {
    public var chunkId: Int
    public var documentId: Int
    public var score: Double
    public init(chunkId: Int, documentId: Int, score: Double) {
        self.chunkId = chunkId; self.documentId = documentId; self.score = score
    }
}

public struct AgentMessage: Codable, Equatable, Sendable, Identifiable {
    public var id: Int
    public var role: String
    public var content: String
    public var citations: [Citation]?
    public init(id: Int, role: String, content: String, citations: [Citation]?) {
        self.id = id; self.role = role; self.content = content; self.citations = citations
    }
}

public struct AgentConversation: Codable, Equatable, Sendable, Identifiable {
    public var id: Int
    public var title: String
    public var messages: [AgentMessage]?
    public init(id: Int, title: String, messages: [AgentMessage]?) {
        self.id = id; self.title = title; self.messages = messages
    }
}

public struct AgentDocument: Codable, Equatable, Sendable, Identifiable {
    public var id: Int
    public var filename: String
    public var size: Int?
    public var chunkCount: Int?
    public var status: String
    public var error: String?
    public init(id: Int, filename: String, size: Int?, chunkCount: Int?, status: String, error: String?) {
        self.id = id; self.filename = filename; self.size = size
        self.chunkCount = chunkCount; self.status = status; self.error = error
    }
}

public struct UploadResult: Codable, Equatable, Sendable {
    public var documentId: Int
    public var runId: String
    public init(documentId: Int, runId: String) { self.documentId = documentId; self.runId = runId }
}

public struct RunIdResult: Codable, Equatable, Sendable {
    public var runId: String
    public init(runId: String) { self.runId = runId }
}

// 对话 SSE:token 增量 / done(带引用)/ error
public enum ChatStreamEvent: Equatable, Sendable {
    case token(String), done(messageId: Int, citations: [Citation]), error(String)
    public static func decode(event: String, data: String) throws -> ChatStreamEvent {
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
public struct RunEvent: Equatable, Sendable {
    public var name: String
    public var data: String
    public init(name: String, data: String) { self.name = name; self.data = data }
}
