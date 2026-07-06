import ComposableArchitecture
import Services
import Core
import Foundation
import Testing
@testable import ContactBook

@MainActor
struct NewFriendsFeatureTests {
    @Test
    func onAppearLoadsRequests() async {
        let requests = [
            FriendRequest(peerId: 2, username: "段宇皓", avatarURL: nil, status: .pending),
            FriendRequest(peerId: 3, username: "王博扬", avatarURL: nil, status: .sent),
        ]
        let store = TestStore(initialState: NewFriendsFeature.State()) {
            NewFriendsFeature()
        } withDependencies: {
            $0.friendRequestClient.list = { requests }
        }
        await store.send(.onAppear) { $0.isLoading = true }
        await store.receive(\.requestsResponse) {
            $0.isLoading = false
            $0.requests = requests
        }
    }

    @Test
    func acceptRepliesAndMarksAccepted() async {
        let requests = [
            FriendRequest(peerId: 2, username: "段宇皓", avatarURL: nil, status: .pending),
        ]
        let store = TestStore(initialState: NewFriendsFeature.State(requests: requests)) {
            NewFriendsFeature()
        } withDependencies: {
            $0.friendRequestClient.reply = { _, _ in }
        }
        await store.send(.acceptTapped(peerId: 2))
        await store.receive(\.accepted) {
            $0.requests[0] = FriendRequest(peerId: 2, username: "段宇皓", avatarURL: nil, status: .accepted)
        }
    }

    @Test
    func rejectRepliesAndMarksBlocked() async {
        let requests = [FriendRequest(peerId: 2, username: "段宇皓", avatarURL: nil, status: .pending)]
        let store = TestStore(initialState: NewFriendsFeature.State(requests: requests)) {
            NewFriendsFeature()
        } withDependencies: {
            $0.friendRequestClient.reply = { _, _ in }
        }
        await store.send(.rejectTapped(peerId: 2))
        await store.receive(\.rejected) {
            $0.requests[0] = FriendRequest(peerId: 2, username: "段宇皓", avatarURL: nil, status: .blocked)
        }
    }

    @Test
    func replyFailureShowsAlert() async {
        let requests = [FriendRequest(peerId: 2, username: "段宇皓", avatarURL: nil, status: .pending)]
        let store = TestStore(initialState: NewFriendsFeature.State(requests: requests)) {
            NewFriendsFeature()
        } withDependencies: {
            $0.friendRequestClient.reply = { _, _ in throw APIError.server(message: "操作失败") }
        }
        await store.send(.acceptTapped(peerId: 2))
        await store.receive(\.replyFailed) {
            $0.alert = AlertState {
                TextState("操作失败")
            } message: {
                TextState("操作失败")
            }
        }
    }

    @Test
    func requestsFailedSetsError() async {
        let store = TestStore(initialState: NewFriendsFeature.State()) {
            NewFriendsFeature()
        } withDependencies: {
            $0.friendRequestClient.list = { throw APIError.transport(message: "x") }
        }
        await store.send(.onAppear) { $0.isLoading = true }
        await store.receive(\.requestsFailed) {
            $0.isLoading = false
            $0.loadError = "网络异常,请检查网络后重试"
        }
    }
}
