import Foundation
import Core
import Testing
@testable import OurChat

struct KeychainStoreTests {
    @Test
    func liveSavesReadsAndDeletes() throws {
        let store = KeychainStore.live(service: "com.ourchat.tests.\(UUID().uuidString)")

        #expect(try store.load(.accessToken) == nil)

        try store.save("at-123", .accessToken)
        try store.save("rt-456", .refreshToken)
        #expect(try store.load(.accessToken) == "at-123")
        #expect(try store.load(.refreshToken) == "rt-456")

        try store.save("at-789", .accessToken)
        #expect(try store.load(.accessToken) == "at-789")

        try store.delete(.accessToken)
        #expect(try store.load(.accessToken) == nil)
        #expect(try store.load(.refreshToken) == "rt-456")

        try store.delete(.refreshToken)
    }

    @Test
    func inMemorySavesReadsAndDeletes() throws {
        let store = KeychainStore.inMemory()

        #expect(try store.load(.accessToken) == nil)
        try store.save("token", .accessToken)
        #expect(try store.load(.accessToken) == "token")
        try store.delete(.accessToken)
        #expect(try store.load(.accessToken) == nil)
    }
}
