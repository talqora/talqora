import Dependencies
import DependenciesMacros
import Foundation

struct AgentRequest: Sendable {
    var method: String; var path: String; var body: Data?
    static func get(_ p: String) -> AgentRequest { .init(method: "GET", path: p, body: nil) }
    static func post(_ p: String, _ body: Data? = nil) -> AgentRequest { .init(method: "POST", path: p, body: body) }
    static func delete(_ p: String) -> AgentRequest { .init(method: "DELETE", path: p, body: nil) }
}

@DependencyClient
struct AgentAPIClient: Sendable {
    var request: @Sendable (_ req: AgentRequest) async throws -> Data
    var upload: @Sendable (_ fileURL: URL, _ fileName: String) async throws -> UploadResult
    var stream: @Sendable (_ req: AgentRequest) -> AsyncThrowingStream<SSEFrame, Error> = { _ in .finished() }
}

extension AgentAPIClient: DependencyKey {
    static let liveValue = AgentAPIClient(
        request: { req in
            @Dependency(\.agentAuth) var auth
            let token = try await auth.ensureToken()
            var r = URLRequest(url: URL(string: AgentEnv.base + req.path)!)
            r.httpMethod = req.method
            r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            if let b = req.body { r.httpBody = b; r.setValue("application/json", forHTTPHeaderField: "Content-Type") }
            let (data, resp) = try await AgentHTTP.rest.data(for: r)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(code) else { throw AgentAPIError.http(code) }
            return data
        },
        upload: { fileURL, fileName in
            @Dependency(\.agentAuth) var auth
            let token = try await auth.ensureToken()
            var r = URLRequest(url: URL(string: AgentEnv.base + "/documents")!)
            r.httpMethod = "POST"
            r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            let boundary = "Boundary-\(UUID().uuidString)"
            r.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            var body = Data()
            let fileData = try Data(contentsOf: fileURL)
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(fileName)\"\r\n".data(using: .utf8)!)
            body.append("Content-Type: application/octet-stream\r\n\r\n".data(using: .utf8)!)
            body.append(fileData)
            body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
            let (data, resp) = try await AgentHTTP.stream.upload(for: r, from: body)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            guard code == 200 || code == 201 else { throw AgentAPIError.http(code) }
            return try JSONDecoder().decode(UploadResult.self, from: data)
        },
        stream: { req in
            AsyncThrowingStream { continuation in
                let task = Task {
                    do {
                        @Dependency(\.agentAuth) var auth
                        let token = try await auth.ensureToken()
                        var r = URLRequest(url: URL(string: AgentEnv.base + req.path)!)
                        r.httpMethod = req.method
                        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                        r.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                        if let b = req.body { r.httpBody = b; r.setValue("application/json", forHTTPHeaderField: "Content-Type") }
                        let (bytes, resp) = try await AgentHTTP.stream.bytes(for: r)
                        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                        guard (200..<300).contains(code) else { throw AgentAPIError.http(code) }
                        var parser = SSEParser()
                        // 逐字节读:遇 "\n" 就把「含该换行的整行」喂给解析器,保留 SSE 的空行(帧分隔 \n\n)。
                        // 注意:不能用 bytes.lines——它会吞掉空行,导致 buffer 永远凑不出 "\n\n"、一帧都吐不出来。
                        var lineBytes = [UInt8]()
                        for try await byte in bytes {
                            lineBytes.append(byte)
                            guard byte == 0x0A else { continue } // 0x0A = "\n"
                            if let s = String(bytes: lineBytes, encoding: .utf8) {
                                for frame in parser.consume(s) { continuation.yield(frame) }
                            }
                            lineBytes.removeAll(keepingCapacity: true)
                        }
                        if !lineBytes.isEmpty, let s = String(bytes: lineBytes, encoding: .utf8) {
                            for frame in parser.consume(s) { continuation.yield(frame) }
                        }
                        continuation.finish()
                    } catch { continuation.finish(throwing: error) }
                }
                continuation.onTermination = { _ in task.cancel() }
            }
        }
    )
    static let previewValue = AgentAPIClient(
        request: { _ in Data() },
        upload: { _, _ in UploadResult(documentId: 0, runId: "") },
        stream: { _ in .finished() }
    )
}
extension DependencyValues { var agentAPI: AgentAPIClient { get { self[AgentAPIClient.self] } set { self[AgentAPIClient.self] = newValue } } }
enum AgentAPIError: Error, Equatable { case http(Int) }
