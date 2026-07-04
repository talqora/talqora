import ComposableArchitecture

// 设置页(图13-15)。真实入口:个人资料、界面与显示、退出登录;其余占位(由 View 直接弹 toast)。
// 本 reducer 只负责把三个真实入口上抛为 delegate,导航/退出由 Me 处理。
@Reducer
struct SettingsFeature {
    @ObservableState
    struct State: Equatable {}

    enum Action {
        case profileTapped
        case appearanceTapped
        case logoutTapped
        case delegate(Delegate)

        enum Delegate: Equatable {
            case openProfile
            case openAppearance
            case logout
        }
    }

    var body: some ReducerOf<Self> {
        Reduce { _, action in
            switch action {
            case .profileTapped:
                return .send(.delegate(.openProfile))
            case .appearanceTapped:
                return .send(.delegate(.openAppearance))
            case .logoutTapped:
                return .send(.delegate(.logout))
            case .delegate:
                return .none
            }
        }
    }
}
