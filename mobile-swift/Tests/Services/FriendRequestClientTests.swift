import Dependencies
@testable import Services
import Core
import Foundation
import Testing
@testable import OurChat

struct FriendRequestClientTests {
    @Test
    func listParsesAndSortsByRecency() async throws {
        let json = #"""
        {"success":true,"data":{
          "2":{"friendId":2,"status":"pending","username":"段宇皓","avatar":"https://x/a.png","updatedAt":"2026-06-25T10:00:00.000Z"},
          "3":{"friendId":3,"status":"sent","username":"王博扬","avatar":null,"updatedAt":"2026-06-26T10:00:00.000Z"}
        }}
        """#
        try await withDependencies {
            $0.sessionClient.currentUserId = { 1 }
            $0.apiClient.perform = { _ in Data(json.utf8) }
        } operation: {
            let requests = try await FriendRequestClient.liveValue.list()
            #expect(requests.count == 2)
            // updatedAt 更新的(王博扬 26 日)排前。
            #expect(requests.first?.peerId == 3)
            #expect(requests.first?.status == .sent)
            let pending = requests.first { $0.peerId == 2 }
            #expect(pending?.username == "段宇皓")
            #expect(pending?.status == .pending)
            #expect(pending?.avatarURL == URL(string: "https://x/a.png"))
        }
    }

    @Test
    func sendPutsAddFriend() async throws {
        let captured = LockIsolatedRequest()
        try await withDependencies {
            $0.sessionClient.currentUserId = { 1 }
            $0.apiClient.perform = { request in
                captured.set(request)
                return Data(#"{"success":true,"data":{"isFriend":false,"friendId":2}}"#.utf8)
            }
        } operation: {
            try await FriendRequestClient.liveValue.send(2)
            #expect(captured.value?.method == .put)
            #expect(captured.value?.path == "/user/addFriend")
        }
    }

    @Test
    func replyThrowsOnServerFailure() async {
        await withDependencies {
            $0.sessionClient.currentUserId = { 1 }
            $0.apiClient.perform = { _ in Data(#"{"success":false,"message":"回复好友请求失败"}"#.utf8) }
        } operation: {
            await #expect(throws: APIError.self) {
                try await FriendRequestClient.liveValue.reply(2, true)
            }
        }
    }
}

// 简易请求捕获器(Sendable),用于断言发出的 APIRequest。
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
