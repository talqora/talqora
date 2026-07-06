import Dependencies
@testable import Services
import Core
import Models
import Foundation
import Testing
@testable import OurChat

struct MeClientTests {
    @Test
    func liveLoadsProfileAndFriendCount() async throws {
        let json = #"{"success":true,"data":{"id":7,"username":"neo","nickname":"尼奥","avatar":"https://x/a.png"}}"#
        try await withDependencies {
            $0.apiClient.perform = { _ in Data(json.utf8) }
            $0.contactsClient.contacts = {
                [
                    Contact(id: "2", name: "A", avatarURL: nil, sectionKey: "A"),
                    Contact(id: "3", name: "B", avatarURL: nil, sectionKey: "B"),
                ]
            }
        } operation: {
            let profile = try await MeClient.liveValue.profile()
            #expect(profile.name == "尼奥")
            #expect(profile.wxid == "7")
            #expect(profile.avatarURL == URL(string: "https://x/a.png"))
            #expect(profile.friendCount == 2)
        }
    }

    @Test
    func liveFallsBackToUsernameWhenNicknameEmpty() async throws {
        let json = #"{"success":true,"data":{"id":9,"username":"trinity","nickname":""}}"#
        try await withDependencies {
            $0.apiClient.perform = { _ in Data(json.utf8) }
            $0.contactsClient.contacts = { [] }
        } operation: {
            let profile = try await MeClient.liveValue.profile()
            #expect(profile.name == "trinity")
            #expect(profile.wxid == "9")
            #expect(profile.friendCount == 0)
        }
    }
}
