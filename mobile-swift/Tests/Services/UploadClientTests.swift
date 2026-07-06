import Dependencies
@testable import Services
import Core
import Foundation
import Testing
@testable import OurChat

struct UploadClientTests {
    @Test
    func uploadImagePostsMultipartAndReturnsURL() async throws {
        let captured = LockIsolatedRequest()
        try await withDependencies {
            $0.apiClient.perform = { request in
                captured.set(request)
                return Data(#"{"success":true,"data":{"url":"https://cdn/x/a.jpg","size":3,"md5":"m"}}"#.utf8)
            }
        } operation: {
            let url = try await UploadClient.liveValue.uploadImage(Data([0x1, 0x2, 0x3]), "image.jpg")
            #expect(url == URL(string: "https://cdn/x/a.jpg"))
            #expect(captured.value?.method == .post)
            #expect(captured.value?.path == "/api/upload/single")
            let contentType = captured.value?.headers["Content-Type"] ?? ""
            #expect(contentType.hasPrefix("multipart/form-data; boundary="))
            // body 必须含 multer 约定的字段名与文件名。
            let body = String(decoding: captured.value?.body ?? Data(), as: UTF8.self)
            #expect(body.contains("name=\"file\""))
            #expect(body.contains("filename=\"image.jpg\""))
        }
    }

    @Test
    func uploadFileUsesGivenNameAndMime() async throws {
        let captured = LockIsolatedRequest()
        try await withDependencies {
            $0.apiClient.perform = { request in
                captured.set(request)
                return Data(#"{"success":true,"data":{"url":"https://cdn/x/report.pdf"}}"#.utf8)
            }
        } operation: {
            let url = try await UploadClient.liveValue.uploadFile(Data([0x1]), "report.pdf", "application/pdf")
            #expect(url == URL(string: "https://cdn/x/report.pdf"))
            let body = String(decoding: captured.value?.body ?? Data(), as: UTF8.self)
            #expect(body.contains("filename=\"report.pdf\""))
            #expect(body.contains("Content-Type: application/pdf"))
        }
    }
}

private final class LockIsolatedRequest: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: APIRequest?
    func set(_ request: APIRequest) {
        lock.lock(); defer { lock.unlock() }
        stored = request
    }
    var value: APIRequest? {
        lock.lock(); defer { lock.unlock() }
        return stored
    }
}
