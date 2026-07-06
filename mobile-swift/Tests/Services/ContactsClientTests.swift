import Dependencies
@testable import Services
import Core
import Foundation
import Testing
@testable import OurChat

struct ContactsClientTests {
    @Test
    func mapsFriendListWithRemarkAndPinyinSection() async throws {
        let json = #"""
        {"success":true,"data":{
          "friendId":{"10":"小明","20":null},
          "friendInfo":{
            "10":{"username":"xiaoming","avatar":"https://x/a.png","gender":"male"},
            "20":{"username":"Alice","avatar":null,"gender":"female"}
          }
        }}
        """#
        try await withDependencies {
            $0.apiClient.perform = { _ in Data(json.utf8) }
            $0.sessionClient.currentUserId = { 1 }
        } operation: {
            let contacts = try await ContactsClient.liveValue.contacts()
            #expect(contacts.count == 2)

            let withRemark = contacts.first { $0.id == "10" }
            #expect(withRemark?.name == "小明") // 备注优先于 username
            #expect(withRemark?.sectionKey == "X") // 拼音 xiaoming → X
            #expect(withRemark?.avatarURL == URL(string: "https://x/a.png"))

            let noRemark = contacts.first { $0.id == "20" }
            #expect(noRemark?.name == "Alice") // 无备注回落 username
            #expect(noRemark?.sectionKey == "A")
            #expect(noRemark?.avatarURL == nil)
        }
    }

    @Test
    func throwsWhenNoSession() async {
        await withDependencies {
            $0.sessionClient.currentUserId = { nil }
        } operation: {
            await #expect(throws: AuthError.notAuthenticated) {
                _ = try await ContactsClient.liveValue.contacts()
            }
        }
    }
}
