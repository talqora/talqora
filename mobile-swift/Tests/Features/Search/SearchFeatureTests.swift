import ComposableArchitecture
import Services
import Foundation
import Testing
@testable import Search

@MainActor
struct SearchFeatureTests {
    @Test
    func queryDebouncesAndShowsResult() async {
        let result = SearchResult(userId: 1024, username: "duanyuhao", avatarURL: nil, isFriend: false)
        let clock = TestClock()
        let store = TestStore(initialState: SearchFeature.State()) {
            SearchFeature()
        } withDependencies: {
            $0.continuousClock = clock
            $0.searchClient.search = { _ in result }
        }
        await store.send(.binding(.set(\.query, "1024"))) {
            $0.query = "1024"
            $0.isSearching = true
        }
        await clock.advance(by: .milliseconds(300))
        await store.receive(\.searchResponse) {
            $0.isSearching = false
            $0.result = result
            $0.notFound = false
        }
    }

    @Test
    func emptyQueryClearsResult() async {
        let store = TestStore(
            initialState: SearchFeature.State(query: "x", result: SearchResult(userId: 1, username: "a", avatarURL: nil, isFriend: false))
        ) {
            SearchFeature()
        } withDependencies: {
            $0.continuousClock = TestClock()
            $0.searchClient.search = { _ in nil }
        }
        await store.send(.binding(.set(\.query, "  "))) {
            $0.query = "  "
            $0.result = nil
            $0.notFound = false
            $0.isSearching = false
        }
    }

    @Test
    func notFoundWhenNoMatch() async {
        let clock = TestClock()
        let store = TestStore(initialState: SearchFeature.State()) {
            SearchFeature()
        } withDependencies: {
            $0.continuousClock = clock
            $0.searchClient.search = { _ in nil }
        }
        await store.send(.binding(.set(\.query, "ghost"))) {
            $0.query = "ghost"
            $0.isSearching = true
        }
        await clock.advance(by: .milliseconds(300))
        await store.receive(\.searchResponse) {
            $0.isSearching = false
            $0.notFound = true
        }
    }

    @Test
    func closeEmitsDelegate() async {
        let store = TestStore(initialState: SearchFeature.State()) {
            SearchFeature()
        }
        await store.send(.closeTapped)
        await store.receive(\.delegate)
    }

    @Test
    func addButtonSendsRequestAndMarksSent() async {
        let result = SearchResult(userId: 1024, username: "duanyuhao", avatarURL: nil, isFriend: false)
        let store = TestStore(initialState: SearchFeature.State(result: result)) {
            SearchFeature()
        } withDependencies: {
            $0.friendRequestClient.send = { _ in }
        }
        await store.send(.addButtonTapped)
        await store.receive(\.addCompleted) {
            $0.requestSent = true
        }
    }

    @Test
    func addButtonNoOpWhenAlreadyFriend() async {
        let result = SearchResult(userId: 1024, username: "duanyuhao", avatarURL: nil, isFriend: true)
        let store = TestStore(initialState: SearchFeature.State(result: result)) {
            SearchFeature()
        }
        await store.send(.addButtonTapped)
    }
}
