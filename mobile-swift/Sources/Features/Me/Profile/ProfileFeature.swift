import ComposableArchitecture
import Services
import Models
import Core
import Foundation

// 个人资料页(图12)。真实业务:头像(上传+裁剪)、名字(nickname);其余字段服务端读不到/不支持,占位。
@Reducer
public struct ProfileFeature {
    public init() {}

    @ObservableState
    public struct State: Equatable {
        public init(
            profile: MeProfile,
            isUploadingAvatar: Bool = false,
            alert: AlertState<Action.Alert>? = nil
        ) {
            self.profile = profile
            self.isUploadingAvatar = isUploadingAvatar
            self.alert = alert
        }
        var profile: MeProfile
        var isUploadingAvatar = false
        @Presents var alert: AlertState<Action.Alert>?
    }

    public enum Action {
        // 名字编辑经 View 的 .alert(含 TextField)输入,确认时带回新名字。
        case nameSaved(String)
        case nameUpdated(String)
        case avatarPicked(Data)
        case avatarUpdated(URL)
        case updateFailed(String)
        case alert(PresentationAction<Alert>)
        case delegate(Delegate)

        public enum Alert: Equatable {}

        public enum Delegate: Equatable {
            // 资料变更:Me 页据此刷新头部展示。
            case profileChanged(MeProfile)
        }
    }

    @Dependency(\.meClient) var meClient
    @Dependency(\.uploadClient) var uploadClient

    public var body: some ReducerOf<Self> {
        Reduce { state, action in
            switch action {
            case let .nameSaved(name):
                let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty, trimmed != state.profile.name else { return .none }
                return .run { [meClient] send in
                    try await meClient.updateName(trimmed)
                    await send(.nameUpdated(trimmed))
                } catch: { error, send in
                    await send(.updateFailed(loadErrorMessage(error)))
                }

            case let .nameUpdated(name):
                state.profile.name = name
                return .send(.delegate(.profileChanged(state.profile)))

            case let .avatarPicked(data):
                state.isUploadingAvatar = true
                return .run { [uploadClient] send in
                    let url = try await uploadClient.uploadImage(data, "avatar.jpg")
                    @Dependency(\.meClient) var meClient
                    try await meClient.updateAvatar(url)
                    await send(.avatarUpdated(url))
                } catch: { error, send in
                    await send(.updateFailed(loadErrorMessage(error)))
                }

            case let .avatarUpdated(url):
                state.isUploadingAvatar = false
                state.profile.avatarURL = url
                return .send(.delegate(.profileChanged(state.profile)))

            case let .updateFailed(message):
                state.isUploadingAvatar = false
                state.alert = AlertState {
                    TextState("更新失败")
                } message: {
                    TextState(message)
                }
                return .none

            case .alert, .delegate:
                return .none
            }
        }
        .ifLet(\.$alert, action: \.alert)
    }
}
