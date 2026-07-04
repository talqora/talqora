import ComposableArchitecture
import Foundation

// 好友资料页(图10):展示头像/昵称/微信号 + 朋友资料/朋友圈入口 + 发消息(真实跳聊天)/音视频通话(占位)。
// 右上⋯ 与「朋友资料」行进入朋友设置页。发消息构造 single_ 会话 id,由上层压入聊天详情。
@Reducer
struct ContactDetailFeature {
    @ObservableState
    struct State: Equatable {
        let contact: Contact
    }

    enum Action {
        case messageTapped
        case settingsTapped
        case callTapped(CallType)
        case delegate(Delegate)

        enum Delegate: Equatable {
            case openChat(conversationId: String, title: String)
            case openSettings(Contact)
            // 发起通话:把被叫方资料上抛,由通话呈现方(MainFeature)补本端资料后建会话。
            case startCall(peer: CallUserDTO, type: CallType)
        }
    }

    @Dependency(\.sessionClient) var sessionClient

    var body: some ReducerOf<Self> {
        Reduce { state, action in
            switch action {
            case .messageTapped:
                // single 会话 id 约定:single_{小 id}_{大 id}(与服务端一致)。
                let myId = sessionClient.currentUserId() ?? 0
                let friendId = Int(state.contact.id) ?? 0
                let conversationId = "single_\(min(myId, friendId))_\(max(myId, friendId))"
                return .send(.delegate(.openChat(conversationId: conversationId, title: state.contact.name)))

            case .settingsTapped:
                return .send(.delegate(.openSettings(state.contact)))

            case let .callTapped(type):
                // 被叫资料取自当前联系人:nickname 用展示名,avatar 用头像 URL 字符串(可能为空)。
                let peer = CallUserDTO(
                    id: Int(state.contact.id) ?? 0,
                    username: state.contact.username,
                    nickname: state.contact.name,
                    avatar: state.contact.avatarURL?.absoluteString ?? ""
                )
                return .send(.delegate(.startCall(peer: peer, type: type)))

            case .delegate:
                return .none
            }
        }
    }
}
