import ComposableArchitecture
import Services
import Models
import Foundation

@Reducer
public struct MeFeature {
    public init() {}

    // 「我」页导航栈目的地:设置 / 个人资料 / 界面与显示。个人资料由头像入口与设置内入口共用。
    @Reducer
    public enum Path {
        case settings(SettingsFeature)
        case profile(ProfileFeature)
        case appearance(AppearanceFeature)
    }

    @ObservableState
    public struct State: Equatable {
        public init(profile: MeProfile = .empty) {
            self.profile = profile
        }
        var profile = MeProfile.empty
        var path = StackState<Path.State>()
    }

    public enum Action {
        case onAppear
        case profileResponse(MeProfile)
        case settingsTapped
        case profileTapped
        case path(StackActionOf<Path>)
        case delegate(Delegate)

        public enum Delegate: Equatable {
            case logout
        }
    }

    @Dependency(\.meClient) var meClient

    public var body: some ReducerOf<Self> {
        Reduce { state, action in
            switch action {
            case .onAppear:
                return .run { [meClient] send in
                    let profile = try await meClient.profile()
                    await send(.profileResponse(profile))
                } catch: { _, _ in
                    // 拉取失败保持空态,不打断「我」页其余入口。
                }

            case let .profileResponse(profile):
                state.profile = profile
                return .none

            case .settingsTapped:
                state.path.append(.settings(SettingsFeature.State()))
                return .none

            case .profileTapped:
                state.path.append(.profile(ProfileFeature.State(profile: state.profile)))
                return .none

            // 设置页入口:个人资料 / 界面与显示 / 退出登录。
            case .path(.element(id: _, action: .settings(.delegate(.openProfile)))):
                state.path.append(.profile(ProfileFeature.State(profile: state.profile)))
                return .none

            case .path(.element(id: _, action: .settings(.delegate(.openAppearance)))):
                state.path.append(.appearance(AppearanceFeature.State()))
                return .none

            case .path(.element(id: _, action: .settings(.delegate(.logout)))):
                return .send(.delegate(.logout))

            // 个人资料变更:同步刷新「我」页头部展示。
            case let .path(.element(id: _, action: .profile(.delegate(.profileChanged(profile))))):
                state.profile = profile
                return .none

            case .path, .delegate:
                return .none
            }
        }
        .forEach(\.path, action: \.path)
    }
}

// 各目的地 State 均 Equatable → 合成 Path.State 的 Equatable(供 StackState 与父 State 满足 Equatable)。
extension MeFeature.Path.State: Equatable {}
