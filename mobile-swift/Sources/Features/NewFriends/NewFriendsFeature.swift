import ComposableArchitecture
import Foundation

// 新的朋友:展示我收到(pending)/发出(sent)/已成(accepted)的好友关系,可接受 pending 请求。
@Reducer
struct NewFriendsFeature {
    @ObservableState
    struct State: Equatable {
        var requests: [FriendRequest] = []
        var isLoading = false
        var loadError: String?
        @Presents var alert: AlertState<Action.Alert>?
    }

    enum Action {
        case onAppear
        case reloadTapped
        case requestsResponse([FriendRequest])
        case requestsFailed(String)
        case acceptTapped(peerId: Int)
        case accepted(peerId: Int)
        case rejectTapped(peerId: Int)
        case rejected(peerId: Int)
        case replyFailed(String)
        case alert(PresentationAction<Alert>)

        enum Alert: Equatable {}
    }

    @Dependency(\.friendRequestClient) var friendRequestClient

    var body: some ReducerOf<Self> {
        Reduce { state, action in
            switch action {
            case .onAppear, .reloadTapped:
                return load(&state)

            case let .requestsResponse(requests):
                state.isLoading = false
                state.loadError = nil
                state.requests = requests
                return .none

            case let .requestsFailed(message):
                state.isLoading = false
                state.loadError = message
                return .none

            case let .acceptTapped(peerId):
                return .run { send in
                    try await friendRequestClient.reply(peerId, true)
                    await send(.accepted(peerId: peerId))
                } catch: { error, send in
                    await send(.replyFailed(loadErrorMessage(error)))
                }

            case let .accepted(peerId):
                // 本地把该请求标为已接受(已是好友),无需整列重拉。
                if let index = state.requests.firstIndex(where: { $0.peerId == peerId }) {
                    let old = state.requests[index]
                    state.requests[index] = FriendRequest(
                        peerId: old.peerId, username: old.username, avatarURL: old.avatarURL, status: .accepted
                    )
                }
                return .none

            case let .rejectTapped(peerId):
                return .run { send in
                    try await friendRequestClient.reply(peerId, false)
                    await send(.rejected(peerId: peerId))
                } catch: { error, send in
                    await send(.replyFailed(loadErrorMessage(error)))
                }

            case let .rejected(peerId):
                // 本地把该请求标为已拒绝(blocked),无需整列重拉。
                if let index = state.requests.firstIndex(where: { $0.peerId == peerId }) {
                    let old = state.requests[index]
                    state.requests[index] = FriendRequest(
                        peerId: old.peerId, username: old.username, avatarURL: old.avatarURL, status: .blocked
                    )
                }
                return .none

            case let .replyFailed(message):
                state.alert = AlertState {
                    TextState("操作失败")
                } message: {
                    TextState(message)
                }
                return .none

            case .alert:
                return .none
            }
        }
        .ifLet(\.$alert, action: \.alert)
    }

    private func load(_ state: inout State) -> Effect<Action> {
        state.isLoading = true
        state.loadError = nil
        return .run { send in
            let requests = try await friendRequestClient.list()
            await send(.requestsResponse(requests))
        } catch: { error, send in
            await send(.requestsFailed(loadErrorMessage(error)))
        }
    }
}
