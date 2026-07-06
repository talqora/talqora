import Dependencies
@testable import Services
import Core
import Models
import Foundation
import Testing
@testable import OurChat

struct AuthServiceTests {
    @Test
    func loginStoresTokenFromEnvelope() async throws {
        let keychain = KeychainStore.inMemory()
        try await withDependencies {
            $0.baseAPIClient.perform = { _ in
                Data(#"{"success":true,"data":{"id":1,"username":"u","token":"at"}}"#.utf8)
            }
            $0.keychain = keychain
        } operation: {
            let tokens = try await AuthService.liveValue.login(username: "u", password: "p", remember: false)
            #expect(tokens == AuthTokens(accessToken: "at", refreshToken: "at"))
            #expect(try keychain.load(.accessToken) == "at")
            #expect(try keychain.load(.refreshToken) == "at")
        }
    }

    @Test
    func loginThrowsOnUnsuccessfulEnvelope() async {
        let keychain = KeychainStore.inMemory()
        await withDependencies {
            $0.baseAPIClient.perform = { _ in
                Data(#"{"success":false,"message":"密码错误"}"#.utf8)
            }
            $0.keychain = keychain
        } operation: {
            await #expect(throws: APIError.server(message: "密码错误")) {
                _ = try await AuthService.liveValue.login(username: "u", password: "bad", remember: false)
            }
        }
    }

    @Test
    func refreshUpdatesStoredToken() async throws {
        let keychain = KeychainStore.inMemory()
        try keychain.save("old-at", .accessToken)
        try await withDependencies {
            $0.baseAPIClient.perform = { _ in
                Data(#"{"success":true,"data":{"token":"new-at"}}"#.utf8)
            }
            $0.keychain = keychain
        } operation: {
            let tokens = try await AuthService.liveValue.refresh()
            #expect(tokens == AuthTokens(accessToken: "new-at", refreshToken: "new-at"))
            #expect(try keychain.load(.accessToken) == "new-at")
            #expect(try keychain.load(.refreshToken) == "new-at")
        }
    }

    @Test
    func refreshThrowsWhenNoTokenStored() async {
        let keychain = KeychainStore.inMemory()
        await withDependencies {
            $0.keychain = keychain
        } operation: {
            await #expect(throws: AuthError.notAuthenticated) {
                _ = try await AuthService.liveValue.refresh()
            }
        }
    }

    @Test
    func logoutClearsTokens() async throws {
        let keychain = KeychainStore.inMemory()
        try keychain.save("at", .accessToken)
        try keychain.save("rt", .refreshToken)
        try await withDependencies {
            $0.keychain = keychain
        } operation: {
            try await AuthService.liveValue.logout()
            #expect(try keychain.load(.accessToken) == nil)
            #expect(try keychain.load(.refreshToken) == nil)
        }
    }
}
