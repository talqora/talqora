import ComposableArchitecture
import Foundation

@Reducer
struct MainFeature {
    enum Tab: Equatable {
        case chats, contacts, discover, me
    }

    @ObservableState
    struct State: Equatable {
        var selectedTab: Tab = .chats
        var chats = ChatsFeature.State()
        var contacts = ContactsFeature.State()
        var me = MeFeature.State()
        // 通话全屏呈现:登录态下始终可被来电/发起唤起,故挂在主界面根部而非某个 tab。
        @Presents var call: CallFeature.State?
    }

    enum Action: BindableAction {
        case binding(BindingAction<State>)
        case onAppear
        case chats(ChatsFeature.Action)
        case contacts(ContactsFeature.Action)
        case me(MeFeature.Action)
        case call(PresentationAction<CallFeature.Action>)
        // 订阅到来电:携当前用户资料建被叫态并转发给 CallFeature 启动其订阅。
        case incomingCall(CallIncoming, localUser: CallUserDTO)
        // 发起通话:补齐本端资料后建主叫态并转发 startCall。
        case placeCall(peer: CallUserDTO, type: CallType, localUser: CallUserDTO)
        case delegate(Delegate)

        enum Delegate: Equatable {
            case loggedOut
        }
    }

    @Dependency(\.authService) var authService
    @Dependency(\.socketClient) var socketClient
    @Dependency(\.sessionClient) var sessionClient
    @Dependency(\.continuousClock) var clock

    private enum CancelID { case incoming }

    var body: some ReducerOf<Self> {
        BindingReducer()
        Scope(state: \.chats, action: \.chats) { ChatsFeature() }
        Scope(state: \.contacts, action: \.contacts) { ContactsFeature() }
        Scope(state: \.me, action: \.me) { MeFeature() }
        Reduce { state, action in
            switch action {
            case .onAppear:
                // 登录态根部长驻订阅来电(cancellable 去重),来电时补当前用户资料后自呈现。
                return subscribeIncoming()

            case let .incomingCall(ev, localUser):
                // 已在通话中则忽略新来电(服务端另有忙线裁决,这里防重复呈现)。
                guard state.call == nil else { return .none }
                var callState = CallFeature.State()
                callState.phase = .incoming
                callState.role = .callee
                callState.callId = ev.callId
                callState.peer = ev.from
                callState.callType = ev.callType
                callState.pendingOffer = ev.offer
                callState.localUser = localUser
                state.call = callState
                // 转发 incomingCall 进子 store,启动其 socket/WebRTC 订阅与状态。
                return .send(.call(.presented(.incomingCall(ev))))

            case let .placeCall(peer, type, localUser):
                guard state.call == nil else { return .none }
                var callState = CallFeature.State()
                callState.role = .caller
                callState.peer = peer
                callState.callType = type
                callState.localUser = localUser
                state.call = callState
                return .send(.call(.presented(.startCall(peer: peer, type: type))))

            case let .contacts(.delegate(.startCall(peer, type))):
                // 好友资料页发起通话:异步取当前用户完整资料(信令要随本端资料给对端做来电展示)。
                return .run { send in
                    let localUser = try await sessionClient.currentUser()
                    await send(.placeCall(peer: peer, type: type, localUser: localUser))
                } catch: { _, send in
                    // 拉本端完整资料失败也要能起呼:退回 JWT 里的同步 id(对端来电或只显示 id,
                    // 但不至于点了发起却毫无反应)。
                    if let uid = sessionClient.currentUserId() {
                        await send(.placeCall(peer: peer, type: type, localUser: CallUserDTO(id: uid, username: "", nickname: "", avatar: "")))
                    }
                }

            case .call(.presented(.delegate(.finished))):
                // 通话收尾:短暂停留让用户看到「已结束/拒绝」文案,再收起呈现。
                return .run { send in
                    try await clock.sleep(for: .seconds(1.5))
                    await send(.call(.dismiss))
                }

            case .me(.delegate(.logout)):
                // 退出登录:清本地凭据后上抛 loggedOut,由 RootFeature 切回登录页。
                return .run { send in
                    try? await authService.logout()
                    await send(.delegate(.loggedOut))
                }

            case .binding, .chats, .contacts, .me, .call, .delegate:
                return .none
            }
        }
        .ifLet(\.$call, action: \.call) {
            CallFeature()
        }
    }

    // 订阅统一事件流,只取来电事件;来电时补当前用户资料后转成 incomingCall。
    private func subscribeIncoming() -> Effect<Action> {
        .run { send in
            for await event in socketClient.events() {
                guard case let .callIncoming(ev) = event else { continue }
                // 被叫振铃只需本端 id(应答时 sendCallAccept 仅带 from:id);此处用 JWT 里的同步 id,
                // 不做网络拉取——否则弱网/接口失败会把来电悄悄丢掉,对端永远收不到呼叫。
                guard let uid = sessionClient.currentUserId() else { continue }
                await send(.incomingCall(ev, localUser: CallUserDTO(id: uid, username: "", nickname: "", avatar: "")))
            }
        }
        .cancellable(id: CancelID.incoming, cancelInFlight: true)
    }
}
