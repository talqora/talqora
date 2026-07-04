import ComposableArchitecture
import Foundation

@Reducer
struct ContactsFeature {
    // 通讯录导航栈的目的地(多类型):新的朋友 / 好友资料 / 好友设置 / 备注编辑 / 聊天详情。
    @Reducer
    enum Path {
        case newFriends(NewFriendsFeature)
        case contactDetail(ContactDetailFeature)
        case friendSettings(FriendSettingsFeature)
        case remarkEdit(RemarkEditFeature)
        case chat(ChatDetailFeature)
    }

    @ObservableState
    struct State: Equatable {
        var contacts: [Contact] = []
        var isLoading = false
        var loadError: String?
        // 收到新好友请求的红点(进入「新的朋友」页即清)。
        var hasNewFriendRequest = false
        // 导航栈:好友 item → 资料页 → 设置页 → 备注编辑;发消息 → 聊天详情。
        var path = StackState<Path.State>()
    }

    enum Action {
        case onAppear
        case reloadTapped
        case contactsResponse([Contact])
        case contactsFailed(String)
        // 统一推送模块分发来的好友实时事件(红点 + 打开时刷新即可,不需 payload)。
        case friendRequestReceived
        case friendListChangedReceived
        case newFriendsTapped
        case contactTapped(Contact)
        case path(StackActionOf<Path>)
    }

    @Dependency(\.contactsClient) var contactsClient
    @Dependency(\.socketClient) var socketClient
    @Dependency(\.sessionClient) var sessionClient

    private enum CancelID { case events }

    var body: some ReducerOf<Self> {
        Reduce { state, action in
            switch action {
            case .onAppear:
                // 事件订阅始终建立(cancellable 去重);联系人仅首次为空时拉。
                let loadEffect: Effect<Action> = (state.contacts.isEmpty && !state.isLoading) ? load(&state) : .none
                return .merge(loadEffect, subscribeEvents())

            case .reloadTapped:
                return load(&state)

            case .friendRequestReceived:
                state.hasNewFriendRequest = true
                // 「新的朋友」页正打开时即时刷新其列表(从服务端拉最新)。
                for id in state.path.ids {
                    if case .newFriends = state.path[id: id] {
                        return .send(.path(.element(id: id, action: .newFriends(.reloadTapped))))
                    }
                }
                return .none

            case .friendListChangedReceived:
                // 好友关系变更:重拉联系人(已有数据时静默更新,不闪 loading)。
                return load(&state)

            case let .contactsResponse(contacts):
                state.isLoading = false
                state.loadError = nil
                state.contacts = contacts
                return .none

            case let .contactsFailed(message):
                // 失败留 error 态(内联重试),不静默当「无联系人」(§3)。
                state.isLoading = false
                state.loadError = message
                return .none

            case .newFriendsTapped:
                state.hasNewFriendRequest = false // 进入即清红点
                state.path.append(.newFriends(NewFriendsFeature.State()))
                return .none

            case let .contactTapped(contact):
                state.path.append(.contactDetail(ContactDetailFeature.State(contact: contact)))
                return .none

            // 好友资料页:发消息 → 压入聊天详情(补当前用户 id 供气泡左右分栏)。
            case let .path(.element(id: _, action: .contactDetail(.delegate(.openChat(conversationId, title))))):
                let myId = sessionClient.currentUserId() ?? 0
                state.path.append(.chat(ChatDetailFeature.State(conversationId: conversationId, title: title, currentUserId: myId)))
                return .none

            // 好友资料页:⋯ / 朋友资料 → 好友设置页。
            case let .path(.element(id: _, action: .contactDetail(.delegate(.openSettings(contact))))):
                state.path.append(.friendSettings(FriendSettingsFeature.State(contact: contact)))
                return .none

            // 好友设置页:设置朋友资料 → 备注编辑。
            case let .path(.element(id: _, action: .friendSettings(.delegate(.openRemarkEdit(contact))))):
                state.path.append(.remarkEdit(RemarkEditFeature.State(contact: contact)))
                return .none

            // 备注编辑保存:本地即时更新展示名 + 重算分组,无需整列重拉。
            case let .path(.element(id: _, action: .remarkEdit(.delegate(.remarkUpdated(friendId, remark))))):
                if let index = state.contacts.firstIndex(where: { $0.id == friendId }) {
                    var contact = state.contacts[index]
                    contact.remark = remark
                    contact.name = remark ?? contact.username
                    contact.sectionKey = ContactSectioning.key(for: contact.name)
                    state.contacts[index] = contact
                }
                return .none

            case .path:
                return .none
            }
        }
        .forEach(\.path, action: \.path)
    }

    private func load(_ state: inout State) -> Effect<Action> {
        state.isLoading = true
        state.loadError = nil
        return .run { send in
            let contacts = try await contactsClient.contacts()
            await send(.contactsResponse(contacts))
        } catch: { error, send in
            await send(.contactsFailed(loadErrorMessage(error)))
        }
    }

    // 订阅统一事件流(events() 内部自动建连),只取好友相关事件转成本 feature 的 action。
    private func subscribeEvents() -> Effect<Action> {
        .run { send in
            for await event in socketClient.events() {
                switch event {
                case .friendRequest:
                    await send(.friendRequestReceived)
                case .friendListChanged:
                    await send(.friendListChangedReceived)
                default:
                    break
                }
            }
        }
        .cancellable(id: CancelID.events, cancelInFlight: true)
    }
}

// 各目的地 State 均 Equatable → 合成 Path.State 的 Equatable(供 StackState 与父 State 满足 Equatable)。
extension ContactsFeature.Path.State: Equatable {}
