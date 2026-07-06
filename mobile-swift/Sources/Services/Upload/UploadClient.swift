import Dependencies
import Core
import Contracts
import DependenciesMacros
import Foundation

// 文件上传:把数据以 multipart/form-data 传到 /api/upload/single,返回可访问 URL。
@DependencyClient
public struct UploadClient: Sendable {
    public var uploadImage: @Sendable (_ data: Data, _ filename: String) async throws -> URL
    public var uploadFile: @Sendable (_ data: Data, _ filename: String, _ mimeType: String) async throws -> URL
}

extension UploadClient: DependencyKey {
    public static let liveValue = UploadClient(
        uploadImage: { data, filename in
            try await upload(data: data, filename: filename, mimeType: "image/jpeg")
        },
        uploadFile: { data, filename, mimeType in
            try await upload(data: data, filename: filename, mimeType: mimeType)
        }
    )

    public static let previewValue = UploadClient(
        uploadImage: { _, _ in URL(string: "https://example.com/preview.jpg")! },
        uploadFile: { _, _, _ in URL(string: "https://example.com/preview.bin")! }
    )
}

// 单文件 multipart 上传,解信封取 url。
private func upload(data: Data, filename: String, mimeType: String) async throws -> URL {
    @Dependency(\.apiClient) var apiClient
    let boundary = "Boundary-\(UUID().uuidString)"
    let request = APIRequest(
        method: .post,
        path: "/api/upload/single",
        headers: ["Content-Type": "multipart/form-data; boundary=\(boundary)"],
        body: multipartBody(boundary: boundary, fieldName: "file", filename: filename, mimeType: mimeType, data: data)
    )
    let result = try await apiClient.sendUnwrapping(request, as: APIUploadResult.self)
    guard let url = URL(string: result.url) else { throw APIError.server(message: "无效的文件地址") }
    return url
}

// 拼一个单文件 multipart body。字段名/文件名/类型按服务端 multer upload.single('file') 约定。
private func multipartBody(boundary: String, fieldName: String, filename: String, mimeType: String, data: Data) -> Data {
    var body = Data()
    body.appendString("--\(boundary)\r\n")
    body.appendString("Content-Disposition: form-data; name=\"\(fieldName)\"; filename=\"\(filename)\"\r\n")
    body.appendString("Content-Type: \(mimeType)\r\n\r\n")
    body.append(data)
    body.appendString("\r\n--\(boundary)--\r\n")
    return body
}

private extension Data {
    mutating func appendString(_ string: String) {
        append(Data(string.utf8))
    }
}

extension DependencyValues {
    public var uploadClient: UploadClient {
        get { self[UploadClient.self] }
        set { self[UploadClient.self] = newValue }
    }
}
