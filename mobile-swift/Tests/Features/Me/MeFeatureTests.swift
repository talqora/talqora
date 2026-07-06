import ComposableArchitecture
import Services
import Models
import Foundation
import Testing
@testable import Me

@MainActor
struct MeFeatureTests {
    @Test
    func onAppearLoadsProfile() async {
        let profile = MeProfile(name: "尼奥", wxid: "7", avatarURL: nil, friendCount: 3)
        let store = TestStore(initialState: MeFeature.State()) {
            MeFeature()
        } withDependencies: {
            $0.meClient.profile = { profile }
        }
        await store.send(.onAppear)
        await store.receive(\.profileResponse) {
            $0.profile = profile
        }
    }

    @Test
    func settingsTappedPushesSettings() async {
        let store = TestStore(initialState: MeFeature.State()) {
            MeFeature()
        }
        await store.send(.settingsTapped) {
            $0.path.append(.settings(SettingsFeature.State()))
        }
    }

    @Test
    func profileTappedPushesProfile() async {
        var state = MeFeature.State()
        state.profile = MeProfile(name: "尼奥", wxid: "7", avatarURL: nil, friendCount: 3)
        let store = TestStore(initialState: state) {
            MeFeature()
        }
        await store.send(.profileTapped) {
            $0.path.append(.profile(ProfileFeature.State(profile: state.profile)))
        }
    }

    @Test
    func settingsLogoutBubblesLogoutDelegate() async {
        var state = MeFeature.State()
        state.path.append(.settings(SettingsFeature.State()))
        let store = TestStore(initialState: state) {
            MeFeature()
        }
        await store.send(.path(.element(id: 0, action: .settings(.delegate(.logout)))))
        await store.receive(\.delegate)
    }

    @Test
    func profileChangedUpdatesHeader() async {
        var state = MeFeature.State()
        state.path.append(.profile(ProfileFeature.State(profile: .empty)))
        let updated = MeProfile(name: "新名", wxid: "7", avatarURL: nil, friendCount: 3)
        let store = TestStore(initialState: state) {
            MeFeature()
        }
        await store.send(.path(.element(id: 0, action: .profile(.delegate(.profileChanged(updated)))))) {
            $0.profile = updated
        }
    }
}
