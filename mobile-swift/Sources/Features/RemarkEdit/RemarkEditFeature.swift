import ComposableArchitecture
import Foundation

// 备注编辑(对齐 web FriendModal 的备注功能)。经好友设置页「设置朋友资料」进入。
@Reducer
struct RemarkEditFeature {
    @ObservableState
    struct State: Equatable {
        let contact: Contact
        var remarkDraft: String
        var isSaving = false
        @Presents var alert: AlertState<Action.Alert>?

        init(contact: Contact) {
            self.contact = contact
            self.remarkDraft = contact.remark ?? ""
        }
    }

    enum Action: BindableAction {
        case binding(BindingAction<State>)
        case saveTapped
        case saved(remark: String?)
        case saveFailed(String)
        case alert(PresentationAction<Alert>)
        case delegate(Delegate)

        enum Alert: Equatable {}

        enum Delegate: Equatable {
            // 备注已更新:上层据此更新联系人展示名。
            case remarkUpdated(friendId: String, remark: String?)
        }
    }

    @Dependency(\.contactsClient) var contactsClient
    @Dependency(\.dismiss) var dismiss

    var body: some ReducerOf<Self> {
        BindingReducer()
        Reduce { state, action in
            switch action {
            case .saveTapped:
                guard let friendId = Int(state.contact.id) else {
                    return .send(.saveFailed("操作失败")) // 非数字 id(理论不该出现):给反馈,不留死按钮
                }
                let trimmed = state.remarkDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                let remark: String? = trimmed.isEmpty ? nil : trimmed
                state.isSaving = true
                return .run { send in
                    try await contactsClient.updateRemark(friendId, remark)
                    await send(.saved(remark: remark))
                } catch: { error, send in
                    await send(.saveFailed(loadErrorMessage(error)))
                }

            case let .saved(remark):
                state.isSaving = false
                // 先通知上层更新联系人,再关闭本页。
                return .concatenate(
                    .send(.delegate(.remarkUpdated(friendId: state.contact.id, remark: remark))),
                    .run { _ in await dismiss() }
                )

            case let .saveFailed(message):
                state.isSaving = false
                state.alert = AlertState {
                    TextState("备注保存失败")
                } message: {
                    TextState(message)
                }
                return .none

            case .binding, .alert, .delegate:
                return .none
            }
        }
        .ifLet(\.$alert, action: \.alert)
    }
}
