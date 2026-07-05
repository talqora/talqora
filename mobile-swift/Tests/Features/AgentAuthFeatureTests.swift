import ComposableArchitecture
import Testing
@testable import OurChat

@MainActor
struct AgentAuthFeatureTests {
    @Test func authorizeSuccessEmitsAuthorized() async {
        let store = TestStore(initialState: AgentAuthFeature.State()) { AgentAuthFeature() } withDependencies: {
            $0.agentAuth.authorize = {}
        }
        await store.send(.authorizeTapped) { $0.isLoading = true }
        await store.receive(\.authorized) { $0.isLoading = false }
        await store.receive(\.delegate)
    }
    @Test func authorizeFailureShowsError() async {
        let store = TestStore(initialState: AgentAuthFeature.State()) { AgentAuthFeature() } withDependencies: {
            $0.agentAuth.authorize = { throw AgentAuthError.mintFailed }
        }
        await store.send(.authorizeTapped) { $0.isLoading = true }
        await store.receive(\.authorizeFailed) { $0.isLoading = false; $0.errorMessage = "授权失败,请重试" }
    }
}
