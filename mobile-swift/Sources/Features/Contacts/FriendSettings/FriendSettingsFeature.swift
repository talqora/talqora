import ComposableArchitecture
import Models
import Foundation

// 朋友设置页(图11)。唯一真实业务:「设置朋友资料」→ 备注编辑;其余(权限/推荐/桌面/星标/黑名单/投诉/删除)为占位。
@Reducer
public struct FriendSettingsFeature {
    @ObservableState
    public struct State: Equatable {
        let contact: Contact
    }

    public enum Action {
        case setRemarkTapped
        case delegate(Delegate)

        public enum Delegate: Equatable {
            case openRemarkEdit(Contact)
        }
    }

    public var body: some ReducerOf<Self> {
        Reduce { state, action in
            switch action {
            case .setRemarkTapped:
                return .send(.delegate(.openRemarkEdit(state.contact)))
            case .delegate:
                return .none
            }
        }
    }
}
