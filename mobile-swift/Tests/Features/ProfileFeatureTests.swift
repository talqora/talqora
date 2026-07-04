import ComposableArchitecture
import Foundation
import Testing
@testable import OurChat

@MainActor
struct ProfileFeatureTests {
    @Test
    func avatarPickedUploadsAndUpdatesProfile() async {
        let url = URL(string: "https://cdn/x/avatar.jpg")!
        let store = TestStore(initialState: ProfileFeature.State(profile: .empty)) {
            ProfileFeature()
        } withDependencies: {
            $0.uploadClient.uploadImage = { _, _ in url }
            $0.meClient.updateAvatar = { _ in }
        }
        await store.send(.avatarPicked(Data([0x1]))) { $0.isUploadingAvatar = true }
        await store.receive(\.avatarUpdated) {
            $0.isUploadingAvatar = false
            $0.profile.avatarURL = url
        }
        await store.receive(\.delegate)
    }

    @Test
    func nameSavedUpdatesProfile() async {
        let store = TestStore(
            initialState: ProfileFeature.State(profile: MeProfile(name: "旧名", wxid: "7", avatarURL: nil, friendCount: 0))
        ) {
            ProfileFeature()
        } withDependencies: {
            $0.meClient.updateName = { _ in }
        }
        await store.send(.nameSaved("新名"))
        await store.receive(\.nameUpdated) { $0.profile.name = "新名" }
        await store.receive(\.delegate)
    }

    @Test
    func nameSavedNoOpWhenUnchanged() async {
        let store = TestStore(
            initialState: ProfileFeature.State(profile: MeProfile(name: "同名", wxid: "7", avatarURL: nil, friendCount: 0))
        ) {
            ProfileFeature()
        }
        // 与当前一致 → 不发起更新,无后续 action。
        await store.send(.nameSaved("同名"))
    }

    @Test
    func updateFailureShowsAlert() async {
        let store = TestStore(initialState: ProfileFeature.State(profile: .empty)) {
            ProfileFeature()
        } withDependencies: {
            $0.uploadClient.uploadImage = { _, _ in throw APIError.server(message: "上传失败") }
        }
        await store.send(.avatarPicked(Data([0x1]))) { $0.isUploadingAvatar = true }
        await store.receive(\.updateFailed) {
            $0.isUploadingAvatar = false
            $0.alert = AlertState {
                TextState("更新失败")
            } message: {
                TextState("上传失败")
            }
        }
    }
}
