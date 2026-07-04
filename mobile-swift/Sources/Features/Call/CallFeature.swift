import ComposableArchitecture
import Foundation

// 1:1 音视频通话状态机:编排 WebRTC 媒体协商与 socket 信令,对齐 web 端 useCall 行为。
// 通话一旦激活(主叫发起 / 被叫振铃)即自订阅 socket + WebRTC 两条事件流,把外部事件
// 转成本 feature 的 inbound action;早到的远端 ICE 交给 WebRTCSession 内部缓冲,不丢弃。
@Reducer
struct CallFeature {
    @ObservableState
    struct State: Equatable {
        var phase: CallPhase = .idle
        var callId: String = ""
        var callType: CallType = .voice
        var peer: CallUserDTO?
        var role: CallRole = .caller
        var pendingOffer: SessionDescriptionDTO?
        var isMuted = false
        var isSpeakerOn = false
        var isCameraOn = true
        var isFrontCamera = true
        var hasRemoteVideo = false
        var durationSeconds = 0
        // 本端登录用户,由父 feature 注入;用于 sendCallAccept(from:) 与 sendCallStart(from:)。
        var localUser: CallUserDTO?
    }

    enum Action {
        // UI 触发
        case startCall(peer: CallUserDTO, type: CallType)
        case acceptTapped
        case rejectTapped
        case hangupTapped
        case toggleMute
        case toggleSpeaker
        case toggleCamera
        case switchCamera
        // 信令入站(由 socket 事件映射而来)
        case incomingCall(CallIncoming)
        case remoteAccepted(answer: SessionDescriptionDTO)
        case remoteRejected
        case remoteEnded
        case remoteBusy(callId: String)
        case remoteIce(IceCandidateDTO)
        case remotePeerReconnecting
        case remoteRejoin(CallRejoin)
        // 媒体事件(由 WebRTC 事件映射而来)
        case localCandidate(IceCandidateDTO)
        case remoteVideoAvailable
        case connectionState(String)
        // 内部
        case tick
        case noAnswerTimeout
        case failed(String)
        // 上抛父 feature:通话已收尾,请求关闭呈现。
        case delegate(Delegate)

        enum Delegate: Equatable {
            case finished
        }
    }

    @Dependency(\.webRTCSession) var webRTC
    @Dependency(\.socketClient) var socket
    @Dependency(\.turnCredentials) var turn
    @Dependency(\.continuousClock) var clock
    @Dependency(\.date) var date

    private enum CancelID { case events, timer, timeout }

    var body: some ReducerOf<Self> {
        Reduce { state, action in
            switch action {

            // MARK: UI 触发

            case let .startCall(peer, type):
                state.peer = peer
                state.callType = type
                state.role = .caller
                state.phase = .outgoing
                let from = state.localUser
                let callId = "call_\(from?.id ?? 0)_\(peer.id)_\(Int(date.now.timeIntervalSince1970 * 1000))"
                state.callId = callId
                let isVideo = type == .video
                return .merge(
                    subscribeEvents(),
                    noAnswerTimeout(),
                    .run { send in
                        let iceServers = try await turn.fetch()
                        await webRTC.configure(iceServers: iceServers, relayOnly: false)
                        try await webRTC.startLocalMedia(video: isVideo)
                        let offer = try await webRTC.createOffer()
                        if let from {
                            socket.sendCallStart(callId: callId, from: from, to: peer, offer: offer, type: type)
                        }
                    } catch: { error, send in
                        await send(.failed(callSetupErrorMessage(error)))
                    }
                )

            case .acceptTapped:
                guard let peer = state.peer, let localUser = state.localUser else { return .none }
                let callId = state.callId
                let isVideo = state.callType == .video
                if let offer = state.pendingOffer {
                    // 正常应答:用缓存的远端 offer 生成 answer 回送。
                    state.phase = .connecting
                    return .run { send in
                        let iceServers = try await turn.fetch()
                        await webRTC.configure(iceServers: iceServers, relayOnly: false)
                        try await webRTC.startLocalMedia(video: isVideo)
                        let answer = try await webRTC.createAnswer(remoteOffer: offer)
                        socket.sendCallAccept(callId: callId, from: localUser.id, to: peer.id, answer: answer)
                    } catch: { error, send in
                        await send(.failed(callSetupErrorMessage(error)))
                    }
                } else {
                    // 刷新丢失了 offer:改为主动 rejoin,自己造一个新 offer 发过去。
                    state.phase = .connecting
                    return .run { send in
                        let iceServers = try await turn.fetch()
                        await webRTC.configure(iceServers: iceServers, relayOnly: false)
                        try await webRTC.startLocalMedia(video: isVideo)
                        let offer = try await webRTC.createOffer()
                        socket.sendCallRejoin(callId: callId, from: localUser, to: peer, offer: offer)
                    } catch: { error, send in
                        await send(.failed(callSetupErrorMessage(error)))
                    }
                }

            case .rejectTapped:
                let callId = state.callId
                state.phase = .ended(reason: "已拒绝")
                return .merge(
                    .run { _ in socket.sendCallReject(callId: callId) },
                    cleanup()
                )

            case .hangupTapped:
                let callId = state.callId
                state.phase = .ended(reason: "通话结束")
                return .merge(
                    .run { _ in socket.sendCallEnd(callId: callId) },
                    cleanup()
                )

            case .toggleMute:
                state.isMuted.toggle()
                let muted = state.isMuted
                return .run { _ in await webRTC.setMuted(muted) }

            case .toggleSpeaker:
                state.isSpeakerOn.toggle()
                let on = state.isSpeakerOn
                return .run { _ in await webRTC.setSpeaker(on) }

            case .toggleCamera:
                state.isCameraOn.toggle()
                let on = state.isCameraOn
                return .run { _ in await webRTC.setCameraEnabled(on) }

            case .switchCamera:
                state.isFrontCamera.toggle()
                return .run { _ in await webRTC.switchCamera() }

            // MARK: 信令入站

            case let .incomingCall(ev):
                state.phase = .incoming
                state.callId = ev.callId
                state.peer = ev.from
                state.callType = ev.callType
                state.role = .callee
                state.pendingOffer = ev.offer
                return subscribeEvents()

            case let .remoteAccepted(answer):
                state.phase = .connecting
                // 对方已应答,离开 .outgoing:取消无应答超时。
                return .merge(
                    .cancel(id: CancelID.timeout),
                    .run { _ in
                        try await webRTC.setRemoteAnswer(answer: answer)
                    } catch: { error, send in
                        await send(.failed(callSetupErrorMessage(error)))
                    }
                )

            case .remoteRejected:
                state.phase = .ended(reason: "对方已拒绝")
                return cleanup()

            case .remoteEnded:
                state.phase = .ended(reason: "通话结束")
                return cleanup()

            case let .remoteBusy(callId):
                guard callId == state.callId else { return .none }
                state.phase = .ended(reason: "对方忙线中")
                return cleanup()

            case let .remoteIce(candidate):
                return .run { _ in await webRTC.addRemoteCandidate(c: candidate) }

            case .remotePeerReconnecting:
                state.phase = .reconnecting
                return .none

            case let .remoteRejoin(ev):
                // 对端刷新后重新发来 offer:重置本端连接,基于新 offer 造 answer 回送。
                guard let localUser = state.localUser, let peer = state.peer else { return .none }
                let callId = state.callId
                state.phase = .connecting
                return .run { send in
                    await webRTC.reset()
                    let answer = try await webRTC.createAnswer(remoteOffer: ev.offer)
                    socket.sendCallAccept(callId: callId, from: localUser.id, to: peer.id, answer: answer)
                } catch: { error, send in
                    await send(.failed(callSetupErrorMessage(error)))
                }

            // MARK: 媒体事件

            case let .localCandidate(candidate):
                let callId = state.callId
                return .run { _ in socket.sendCallIce(callId: callId, candidate: candidate) }

            case .remoteVideoAvailable:
                state.hasRemoteVideo = true
                return .none

            case let .connectionState(connState):
                switch connState {
                case "connected":
                    state.phase = .connected
                    return .run { send in
                        for await _ in clock.timer(interval: .seconds(1)) {
                            await send(.tick)
                        }
                    }
                    .cancellable(id: CancelID.timer, cancelInFlight: true)
                case "failed":
                    return .send(.failed("连接失败"))
                default:
                    return .none
                }

            // MARK: 内部

            case .tick:
                state.durationSeconds += 1
                return .none

            case .noAnswerTimeout:
                // 仅在仍处于 .outgoing(对方一直未应答)时收尾;已进入协商/连接则忽略。
                guard state.phase == .outgoing else { return .none }
                state.phase = .ended(reason: "对方无应答")
                return cleanup()

            case let .failed(message):
                state.phase = .ended(reason: message)
                return cleanup()

            case .delegate:
                return .none
            }
        }
    }

    // 通话激活后建立的长驻订阅:合并 WebRTC 与 socket 两条事件流,把外部事件转成 inbound action。
    // socket 只取 call:* 事件,message/friend 等无关事件忽略。
    private func subscribeEvents() -> Effect<Action> {
        .merge(
            .run { send in
                for await event in webRTC.events() {
                    switch event {
                    case let .localCandidate(candidate):
                        await send(.localCandidate(candidate))
                    case .remoteVideoAvailable:
                        await send(.remoteVideoAvailable)
                    case let .connectionState(connState):
                        await send(.connectionState(connState))
                    }
                }
            },
            .run { send in
                for await event in socket.events() {
                    switch event {
                    case let .callIncoming(ev):
                        await send(.incomingCall(ev))
                    case let .callAccepted(_, answer):
                        await send(.remoteAccepted(answer: answer))
                    case .callRejected:
                        await send(.remoteRejected)
                    case .callEnded:
                        await send(.remoteEnded)
                    case let .callBusy(callId):
                        await send(.remoteBusy(callId: callId))
                    case let .callIce(_, candidate):
                        await send(.remoteIce(candidate))
                    case .callPeerReconnecting:
                        await send(.remotePeerReconnecting)
                    case let .callRejoin(ev):
                        await send(.remoteRejoin(ev))
                    case .message, .friendRequest, .friendListChanged, .callHandled:
                        break
                    }
                }
            }
        )
        .cancellable(id: CancelID.events, cancelInFlight: true)
    }

    // 主叫无应答超时:60s 内若仍未离开 .outgoing(未收到 accept),自动收尾。
    // 用可取消 effect,离开 .outgoing 时取消(remoteAccepted / cleanup)。
    private func noAnswerTimeout() -> Effect<Action> {
        .run { send in
            try await clock.sleep(for: .seconds(60))
            await send(.noAnswerTimeout)
        }
        .cancellable(id: CancelID.timeout, cancelInFlight: true)
    }

    // 结束通话统一清理:取消订阅 + 计时器 + 无应答超时,关闭 WebRTC 会话释放媒体资源,并上抛 finished 请父层收起呈现。
    // 所有进入 .ended 的迁移都经此,故 finished 恰好每次通话结束发一次。
    private func cleanup() -> Effect<Action> {
        .merge(
            .cancel(id: CancelID.events),
            .cancel(id: CancelID.timer),
            .cancel(id: CancelID.timeout),
            .run { _ in await webRTC.close() },
            .send(.delegate(.finished))
        )
    }
}

// TURN 拉取 / 媒体启动 / SDP 协商任一步失败时给的文案。
// 权限被拒可区分,给针对性提示;其余走兜底。
private func callSetupErrorMessage(_ error: Error) -> String {
    if let e = error as? CallMediaError {
        switch e {
        case .microphonePermissionDenied: return "需要麦克风权限才能通话"
        case .cameraPermissionDenied: return "需要摄像头权限才能视频通话"
        }
    }
    return "通话建立失败"
}
