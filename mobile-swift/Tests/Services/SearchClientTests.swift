import Dependencies
@testable import Services
import Core
import Foundation
import Testing
@testable import OurChat

struct SearchClientTests {
    @Test
    func liveReturnsMatchedUser() async throws {
        let json = #"{"success":true,"data":{"exist":true,"isFriend":false,"friendInfo":{"id":1024,"username":"duanyuhao","avatar":"https://x/a.png","gender":"male"}}}"#
        try await withDependencies {
            $0.sessionClient.currentUserId = { 1 }
            $0.apiClient.perform = { _ in Data(json.utf8) }
        } operation: {
            let result = try await SearchClient.liveValue.search("1024")
            #expect(result?.userId == 1024)
            #expect(result?.username == "duanyuhao")
            #expect(result?.avatarURL == URL(string: "https://x/a.png"))
            #expect(result?.isFriend == false)
        }
    }

    @Test
    func liveMarksAlreadyFriend() async throws {
        let json = #"{"success":false,"message":"已经是好友","data":{"exist":true,"isFriend":true,"friendInfo":{"id":2,"username":"neo","avatar":null}}}"#
        try await withDependencies {
            $0.sessionClient.currentUserId = { 1 }
            $0.apiClient.perform = { _ in Data(json.utf8) }
        } operation: {
            let result = try await SearchClient.liveValue.search("neo")
            #expect(result?.userId == 2)
            #expect(result?.isFriend == true)
        }
    }

    @Test
    func liveReturnsNilWhenNotFound() async throws {
        let json = #"{"success":false,"message":"用户不存在","data":{"exist":false,"isFriend":false,"friendInfo":null}}"#
        try await withDependencies {
            $0.sessionClient.currentUserId = { 1 }
            $0.apiClient.perform = { _ in Data(json.utf8) }
        } operation: {
            let result = try await SearchClient.liveValue.search("ghost")
            #expect(result == nil)
        }
    }
}
