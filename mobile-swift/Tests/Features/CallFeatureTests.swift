import ComposableArchitecture
import Foundation
import Testing
@testable import OurChat

// 复用的测试用户与信令载荷。放在文件作用域(非 MainActor 隔离),
// 供 @Sendable 依赖 override 闭包在任意执行上下文引用。
private let me = CallUserDTO(id: 1, username: "me", nickname: "Me", avatar: "")
private let peer = CallUserDTO(id: 2, username: "peer", nickname: "Peer", avatar: "")
private let offer = SessionDescriptionDTO(type: "offer", sdp: "OFFER")
private let answer = SessionDescriptionDTO(type: "answer", sdp: "ANSWER")

private enum CallTestError: Error { case boom }

@MainActor
struct CallFeatureTests {
    private func incomingState() -> CallFeature.State {
        var state = CallFeature.State()
        state.localUser = me
        return state
    }

    // MARK: 被叫振铃 → 拒绝 → 结束

    @Test
    func incomingCallEntersRingingAndSubscribes() async {
        let store = TestStore(initialState: incomingState()) {
            CallFeature()
        } withDependencies: {
            $0.socketClient.events = { .finished }
            $0.webRTCSession.events = { .finished }
        }
        let ev = CallIncoming(callId: "c1", from: peer, to: me, offer: offer, callType: .voice)
        await store.send(.incomingCall(ev)) {
            $0.phase = .incoming
            $0.callId = "c1"
            $0.peer = peer
            $0.callType = .voice
            $0.role = .callee
            $0.pendingOffer = offer
        }
    }

    @Test
    func rejectTappedEndsCallAndSignals() async {
        let (rejected, rejectedCont) = AsyncStream<String>.makeStream()
        var state = incomingState()
        state.phase = .incoming
        state.callId = "c1"
        state.peer = peer
        state.pendingOffer = offer
        let store = TestStore(initialState: state) {
            CallFeature()
        } withDependencies: {
            $0.socketClient.sendCallReject = { rejectedCont.yield($0); rejectedCont.finish() }
            $0.webRTCSession.close = {}
        }
        await store.send(.rejectTapped) {
            $0.phase = .ended(reason: "已拒绝")
        }
        await store.receive(\.delegate)
        var sent: String?
        for await id in rejected { sent = id; break }
        #expect(sent == "c1")
    }

    // MARK: 主叫忙线

    @Test
    func remoteBusyEndsOutgoingCall() async {
        var state = incomingState()
        state.phase = .outgoing
        state.callId = "c9"
        let store = TestStore(initialState: state) {
            CallFeature()
        } withDependencies: {
            $0.webRTCSession.close = {}
        }
        await store.send(.remoteBusy(callId: "c9")) {
            $0.phase = .ended(reason: "对方忙线中")
        }
        await store.receive(\.delegate)
    }

    @Test
    func remoteBusyIgnoresMismatchedCallId() async {
        var state = incomingState()
        state.phase = .outgoing
        state.callId = "c9"
        let store = TestStore(initialState: state) {
            CallFeature()
        }
        // callId 不匹配 → 无迁移、无 effect。
        await store.send(.remoteBusy(callId: "other"))
    }

    // MARK: 主叫发起

    @Test
    func startCallGoesOutgoingAndSendsOffer() async {
        let clock = TestClock()
        let (started, startedCont) = AsyncStream<SessionDescriptionDTO>.makeStream()
        let store = TestStore(initialState: incomingState()) {
            CallFeature()
        } withDependencies: {
            $0.date = .constant(Date(timeIntervalSince1970: 0))
            $0.continuousClock = clock
            $0.turnCredentials.fetch = { [] }
            $0.webRTCSession.configure = { _, _ in }
            $0.webRTCSession.startLocalMedia = { _ in }
            $0.webRTCSession.createOffer = { offer }
            $0.webRTCSession.events = { .finished }
            $0.socketClient.events = { .finished }
            $0.socketClient.sendCallStart = { _, _, _, offer, _ in
                startedCont.yield(offer); startedCont.finish()
            }
            $0.webRTCSession.close = {}
        }
        store.exhaustivity = .off(showSkippedAssertions: false)
        await store.send(.startCall(peer: peer, type: .video)) {
            $0.peer = peer
            $0.callType = .video
            $0.role = .caller
            $0.phase = .outgoing
        }
        var sentOffer: SessionDescriptionDTO?
        for await offer in started { sentOffer = offer; break }
        #expect(sentOffer == offer)
        // 挂断取消无应答超时,让长驻 effect 收敛后再 finish。
        await store.send(.hangupTapped)
        await store.finish()
    }

    // MARK: 主叫无应答超时

    @Test
    func startCallTimesOutWhenNoAnswer() async {
        let clock = TestClock()
        let store = TestStore(initialState: incomingState()) {
            CallFeature()
        } withDependencies: {
            $0.date = .constant(Date(timeIntervalSince1970: 0))
            $0.continuousClock = clock
            $0.turnCredentials.fetch = { [] }
            $0.webRTCSession.configure = { _, _ in }
            $0.webRTCSession.startLocalMedia = { _ in }
            $0.webRTCSession.createOffer = { offer }
            $0.webRTCSession.events = { .finished }
            $0.socketClient.events = { .finished }
            $0.socketClient.sendCallStart = { _, _, _, _, _ in }
            $0.webRTCSession.close = {}
        }
        store.exhaustivity = .off(showSkippedAssertions: false)
        await store.send(.startCall(peer: peer, type: .voice)) {
            $0.phase = .outgoing
        }
        // 60s 内无 accept:超时触发,收尾为无应答。
        await clock.advance(by: .seconds(60))
        await store.receive(\.noAnswerTimeout) {
            $0.phase = .ended(reason: "对方无应答")
        }
        await store.receive(\.delegate)
        await store.finish()
    }

    // accept 先于 60s 到达时,超时被取消,不会再收尾为无应答。
    @Test
    func remoteAcceptedCancelsNoAnswerTimeout() async {
        let clock = TestClock()
        let store = TestStore(initialState: incomingState()) {
            CallFeature()
        } withDependencies: {
            $0.date = .constant(Date(timeIntervalSince1970: 0))
            $0.continuousClock = clock
            $0.turnCredentials.fetch = { [] }
            $0.webRTCSession.configure = { _, _ in }
            $0.webRTCSession.startLocalMedia = { _ in }
            $0.webRTCSession.createOffer = { offer }
            $0.webRTCSession.setRemoteAnswer = { _ in }
            $0.webRTCSession.events = { .finished }
            $0.socketClient.events = { .finished }
            $0.socketClient.sendCallStart = { _, _, _, _, _ in }
            $0.socketClient.sendCallEnd = { _ in }
            $0.webRTCSession.close = {}
        }
        store.exhaustivity = .off(showSkippedAssertions: false)
        await store.send(.startCall(peer: peer, type: .voice)) {
            $0.phase = .outgoing
        }
        await clock.advance(by: .seconds(30))
        await store.send(.remoteAccepted(answer: answer)) {
            $0.phase = .connecting
        }
        // 超时已取消:再推进过 60s 也不应有 noAnswerTimeout。
        await clock.advance(by: .seconds(60))
        // 收尾长驻订阅,让 finish 收敛。
        await store.send(.hangupTapped) {
            $0.phase = .ended(reason: "通话结束")
        }
        await store.receive(\.delegate)
        await store.finish()
    }

    // MARK: 权限被拒 → 针对性文案

    @Test
    func acceptTappedMicrophoneDeniedShowsMessage() async {
        var state = incomingState()
        state.phase = .incoming
        state.callId = "c1"
        state.peer = peer
        state.pendingOffer = offer
        let store = TestStore(initialState: state) {
            CallFeature()
        } withDependencies: {
            $0.turnCredentials.fetch = { [] }
            $0.webRTCSession.configure = { _, _ in }
            $0.webRTCSession.startLocalMedia = { _ in throw CallMediaError.microphonePermissionDenied }
            $0.webRTCSession.close = {}
        }
        await store.send(.acceptTapped) {
            $0.phase = .connecting
        }
        await store.receive(\.failed) {
            $0.phase = .ended(reason: "需要麦克风权限才能通话")
        }
        await store.receive(\.delegate)
    }

    // MARK: 被叫应答(有 pendingOffer)

    @Test
    func acceptTappedWithOfferConnectsAndSendsAnswer() async {
        let (accepted, acceptedCont) = AsyncStream<SessionDescriptionDTO>.makeStream()
        var state = incomingState()
        state.phase = .incoming
        state.callId = "c1"
        state.peer = peer
        state.pendingOffer = offer
        let store = TestStore(initialState: state) {
            CallFeature()
        } withDependencies: {
            $0.turnCredentials.fetch = { [] }
            $0.webRTCSession.configure = { _, _ in }
            $0.webRTCSession.startLocalMedia = { _ in }
            $0.webRTCSession.createAnswer = { _ in answer }
            $0.socketClient.sendCallAccept = { _, _, _, answer in
                acceptedCont.yield(answer); acceptedCont.finish()
            }
        }
        await store.send(.acceptTapped) {
            $0.phase = .connecting
        }
        var sentAnswer: SessionDescriptionDTO?
        for await answer in accepted { sentAnswer = answer; break }
        #expect(sentAnswer == answer)
    }

    @Test
    func acceptTappedWithoutOfferSendsRejoin() async {
        let (rejoined, rejoinedCont) = AsyncStream<SessionDescriptionDTO>.makeStream()
        var state = incomingState()
        state.phase = .incoming
        state.callId = "c1"
        state.peer = peer
        state.pendingOffer = nil
        let store = TestStore(initialState: state) {
            CallFeature()
        } withDependencies: {
            $0.turnCredentials.fetch = { [] }
            $0.webRTCSession.configure = { _, _ in }
            $0.webRTCSession.startLocalMedia = { _ in }
            $0.webRTCSession.createOffer = { offer }
            $0.socketClient.sendCallRejoin = { _, _, _, offer in
                rejoinedCont.yield(offer); rejoinedCont.finish()
            }
        }
        await store.send(.acceptTapped) {
            $0.phase = .connecting
        }
        var sentOffer: SessionDescriptionDTO?
        for await offer in rejoined { sentOffer = offer; break }
        #expect(sentOffer == offer)
    }

    // MARK: 主叫收到 accept

    @Test
    func remoteAcceptedSetsRemoteAnswerAndConnects() async {
        let (set, setCont) = AsyncStream<SessionDescriptionDTO>.makeStream()
        var state = incomingState()
        state.phase = .outgoing
        let store = TestStore(initialState: state) {
            CallFeature()
        } withDependencies: {
            $0.webRTCSession.setRemoteAnswer = { answer in setCont.yield(answer); setCont.finish() }
        }
        await store.send(.remoteAccepted(answer: answer)) {
            $0.phase = .connecting
        }
        var got: SessionDescriptionDTO?
        for await a in set { got = a; break }
        #expect(got == answer)
    }

    @Test
    func remoteAcceptedFailureEndsCall() async {
        var state = incomingState()
        state.phase = .outgoing
        let store = TestStore(initialState: state) {
            CallFeature()
        } withDependencies: {
            $0.webRTCSession.setRemoteAnswer = { _ in throw CallTestError.boom }
            $0.webRTCSession.close = {}
        }
        await store.send(.remoteAccepted(answer: answer)) {
            $0.phase = .connecting
        }
        await store.receive(\.failed) {
            $0.phase = .ended(reason: "通话建立失败")
        }
        await store.receive(\.delegate)
    }

    // MARK: ICE 收发

    @Test
    func remoteIceAddsRemoteCandidate() async {
        let (added, addedCont) = AsyncStream<IceCandidateDTO>.makeStream()
        let candidate = IceCandidateDTO(candidate: "cand", sdpMlineIndex: 0, sdpMid: "0")
        let store = TestStore(initialState: incomingState()) {
            CallFeature()
        } withDependencies: {
            $0.webRTCSession.addRemoteCandidate = { c in addedCont.yield(c); addedCont.finish() }
        }
        await store.send(.remoteIce(candidate))
        var got: IceCandidateDTO?
        for await c in added { got = c; break }
        #expect(got == candidate)
    }

    @Test
    func localCandidateSendsIce() async {
        let (sent, sentCont) = AsyncStream<IceCandidateDTO>.makeStream()
        let candidate = IceCandidateDTO(candidate: "local", sdpMlineIndex: 1, sdpMid: "1")
        var state = incomingState()
        state.callId = "c1"
        let store = TestStore(initialState: state) {
            CallFeature()
        } withDependencies: {
            $0.socketClient.sendCallIce = { _, c in sentCont.yield(c); sentCont.finish() }
        }
        await store.send(.localCandidate(candidate))
        var got: IceCandidateDTO?
        for await c in sent { got = c; break }
        #expect(got == candidate)
    }

    // MARK: 连接建立 → 计时

    @Test
    func connectedStartsDurationTimer() async {
        let clock = TestClock()
        var state = incomingState()
        state.phase = .connecting
        let store = TestStore(initialState: state) {
            CallFeature()
        } withDependencies: {
            $0.continuousClock = clock
            $0.socketClient.sendCallEnd = { _ in }
            $0.webRTCSession.close = {}
        }
        await store.send(.connectionState("connected")) {
            $0.phase = .connected
        }
        await clock.advance(by: .seconds(1))
        await store.receive(\.tick) { $0.durationSeconds = 1 }
        await clock.advance(by: .seconds(1))
        await store.receive(\.tick) { $0.durationSeconds = 2 }
        // 结束长驻计时器,避免 TestStore 报未完成 effect。
        await store.send(.hangupTapped) {
            $0.phase = .ended(reason: "通话结束")
        }
        await store.receive(\.delegate)
    }

    @Test
    func connectionFailedEndsCall() async {
        var state = incomingState()
        state.phase = .connecting
        let store = TestStore(initialState: state) {
            CallFeature()
        } withDependencies: {
            $0.webRTCSession.close = {}
        }
        await store.send(.connectionState("failed"))
        await store.receive(\.failed) {
            $0.phase = .ended(reason: "连接失败")
        }
        await store.receive(\.delegate)
    }

    // MARK: 独立迁移

    @Test
    func tickIncrementsDuration() async {
        var state = incomingState()
        state.phase = .connected
        let store = TestStore(initialState: state) {
            CallFeature()
        }
        await store.send(.tick) { $0.durationSeconds = 1 }
    }

    @Test
    func toggleMuteFlipsAndAppliesToSession() async {
        let (muted, mutedCont) = AsyncStream<Bool>.makeStream()
        let store = TestStore(initialState: incomingState()) {
            CallFeature()
        } withDependencies: {
            $0.webRTCSession.setMuted = { m in mutedCont.yield(m); mutedCont.finish() }
        }
        await store.send(.toggleMute) { $0.isMuted = true }
        var got: Bool?
        for await m in muted { got = m; break }
        #expect(got == true)
    }

    @Test
    func remoteVideoAvailableSetsFlag() async {
        let store = TestStore(initialState: incomingState()) {
            CallFeature()
        }
        await store.send(.remoteVideoAvailable) { $0.hasRemoteVideo = true }
    }

    @Test
    func remotePeerReconnectingEntersReconnecting() async {
        var state = incomingState()
        state.phase = .connected
        let store = TestStore(initialState: state) {
            CallFeature()
        }
        await store.send(.remotePeerReconnecting) { $0.phase = .reconnecting }
    }

    @Test
    func remoteEndedEndsCall() async {
        var state = incomingState()
        state.phase = .connected
        let store = TestStore(initialState: state) {
            CallFeature()
        } withDependencies: {
            $0.webRTCSession.close = {}
        }
        await store.send(.remoteEnded) { $0.phase = .ended(reason: "通话结束") }
        await store.receive(\.delegate)
    }

    @Test
    func remoteRejectedEndsCall() async {
        var state = incomingState()
        state.phase = .outgoing
        let store = TestStore(initialState: state) {
            CallFeature()
        } withDependencies: {
            $0.webRTCSession.close = {}
        }
        await store.send(.remoteRejected) { $0.phase = .ended(reason: "对方已拒绝") }
        await store.receive(\.delegate)
    }

    @Test
    func remoteRejoinResetsAndSendsAnswer() async {
        let (accepted, acceptedCont) = AsyncStream<SessionDescriptionDTO>.makeStream()
        var state = incomingState()
        state.phase = .connected
        state.callId = "c1"
        state.peer = peer
        let store = TestStore(initialState: state) {
            CallFeature()
        } withDependencies: {
            $0.webRTCSession.reset = {}
            $0.webRTCSession.createAnswer = { _ in answer }
            $0.socketClient.sendCallAccept = { _, _, _, answer in
                acceptedCont.yield(answer); acceptedCont.finish()
            }
        }
        let ev = CallRejoin(callId: "c1", from: peer, to: me, offer: offer)
        await store.send(.remoteRejoin(ev)) {
            $0.phase = .connecting
        }
        var got: SessionDescriptionDTO?
        for await a in accepted { got = a; break }
        #expect(got == answer)
    }

    // MARK: 收尾委托

    // 进入 .ended 时应上抛 delegate(.finished),供父层收起呈现。
    @Test
    func reachingEndedEmitsDelegateFinished() async {
        var state = incomingState()
        state.phase = .connected
        let store = TestStore(initialState: state) {
            CallFeature()
        } withDependencies: {
            $0.webRTCSession.close = {}
        }
        await store.send(.remoteEnded) { $0.phase = .ended(reason: "通话结束") }
        await store.receive(\.delegate) // .finished
    }

    // MARK: 订阅事件流(受控 AsyncStream)驱动 inbound action

    @Test
    func socketSubscriptionForwardsCallEvents() async {
        let (socketStream, socketCont) = AsyncStream<ServerEvent>.makeStream()
        var state = incomingState()
        state.phase = .incoming
        state.callId = "c1"
        state.peer = peer
        state.pendingOffer = offer
        let store = TestStore(initialState: state) {
            CallFeature()
        } withDependencies: {
            $0.socketClient.events = { socketStream }
            $0.webRTCSession.events = { .finished }
            $0.webRTCSession.setRemoteAnswer = { _ in }
            $0.webRTCSession.close = {}
        }
        store.exhaustivity = .off(showSkippedAssertions: false)
        // 用 incomingCall 启动订阅(即便 state 已就绪,这里仅为触发 subscribeEvents)。
        let incoming = CallIncoming(callId: "c1", from: peer, to: me, offer: offer, callType: .voice)
        await store.send(.incomingCall(incoming))
        // 通过受控 socket 流投递一个 call:accept,应被转成 remoteAccepted。
        socketCont.yield(.callAccepted(callId: "c1", answer: answer))
        await store.receive(\.remoteAccepted) {
            $0.phase = .connecting
        }
        // 无关事件(好友变更)应被忽略,不产生 action。
        socketCont.yield(.friendListChanged)
        socketCont.finish()
        // 收尾:结束通话取消订阅。
        await store.send(.remoteEnded)
        await store.finish()
    }
}
