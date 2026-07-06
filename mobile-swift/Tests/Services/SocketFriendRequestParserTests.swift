import Foundation
@testable import Services
import Testing
@testable import OurChat

struct SocketFriendRequestParserTests {
    @Test
    func parsesReceiveFriendReqPayload() {
        let raw: [String: Any] = [
            "id": 0,
            "userId": 1,
            "friendId": NSNumber(value: 2),
            "status": "pending",
            "username": "段宇皓",
            "avatar": "https://cdn/x/a.jpg",
        ]
        let request = SocketFriendRequestParser.parse(raw)
        #expect(request?.peerId == 2)
        #expect(request?.username == "段宇皓")
        #expect(request?.avatarURL == URL(string: "https://cdn/x/a.jpg"))
        #expect(request?.status == .pending)
    }

    @Test
    func fallsBackWhenOptionalFieldsMissing() {
        let request = SocketFriendRequestParser.parse(["friendId": 5] as [String: Any])
        #expect(request?.peerId == 5)
        #expect(request?.username == "5") // 无 username 回退到 id 字符串
        #expect(request?.avatarURL == nil)
        #expect(request?.status == .pending) // 无 status 默认 pending
    }

    @Test
    func returnsNilWhenFriendIdMissing() {
        #expect(SocketFriendRequestParser.parse(["username": "x"] as [String: Any]) == nil)
    }
}
