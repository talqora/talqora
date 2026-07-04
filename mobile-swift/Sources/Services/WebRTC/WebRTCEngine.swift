import Foundation
import WebRTC

// 拥有非 Sendable 的 RTCPeerConnection 及媒体轨,所有 RTC 对象都被隔离在 actor 内部,
// 不逃逸到 async 边界之外;delegate 在回调边界把 RTC 类型转成 Sendable 的 DTO/字符串再送出。
actor RTCEngine {
    // 全实例共享单个 factory(libwebrtc 推荐、内部线程安全);仅在 actor 内被访问,
    // nonisolated(unsafe) 只为绕过 RTCPeerConnectionFactory 非 Sendable 的静态存储检查。
    private nonisolated(unsafe) static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory(
            encoderFactory: RTCDefaultVideoEncoderFactory(),
            decoderFactory: RTCDefaultVideoDecoderFactory()
        )
    }()

    private static var sendRecvConstraints: RTCMediaConstraints {
        RTCMediaConstraints(
            mandatoryConstraints: ["OfferToReceiveAudio": "true", "OfferToReceiveVideo": "true"],
            optionalConstraints: nil
        )
    }

    private var pc: RTCPeerConnection?
    private var audioTrack: RTCAudioTrack?
    private var candidateBuffer = CandidateBuffer()
    private var subscribers: [UUID: AsyncStream<WebRTCEvent>.Continuation] = [:]
    private var relayOnly = false
    private var iceServers: [IceServerDTO] = []
    private let delegate = PCDelegate()

    init() {
        // set-once 不变量:sink 在 init 里、任何 RTCPeerConnection 存在之前就绑定,之后不再改。
        // init 完成 happens-before 后续 actor 隔离的 configure()/buildPC(),而 PC 回调只会在
        // buildPC 之后触发;故这次写入 happens-before 每次信令线程上的读取(无竞争),
        // 且 sink 在任何 PC 发事件前已就位(不丢早到的本地候选/状态)。
        delegate.attach { [weak self] event in
            Task { await self?.ingest(event) }
        }
    }

    func addSubscriber(_ c: AsyncStream<WebRTCEvent>.Continuation) {
        let id = UUID()
        subscribers[id] = c
        c.onTermination = { [weak self] _ in
            Task { await self?.removeSubscriber(id) }
        }
    }

    private func removeSubscriber(_ id: UUID) { subscribers[id] = nil }

    func configure(_ servers: [IceServerDTO], relayOnly: Bool) {
        iceServers = servers
        self.relayOnly = relayOnly
        buildPC()
    }

    private func buildPC() {
        let cfg = RTCConfiguration()
        cfg.iceServers = iceServers.map {
            RTCIceServer(urlStrings: $0.urls, username: $0.username, credential: $0.credential)
        }
        cfg.sdpSemantics = .unifiedPlan
        if relayOnly { cfg.iceTransportPolicy = .relay }
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        pc = Self.factory.peerConnection(with: cfg, constraints: constraints, delegate: delegate)
    }

    func startLocalMedia(video _: Bool) {
        guard let pc else { return }
        configureAudioSession()
        let source = Self.factory.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
        let track = Self.factory.audioTrack(with: source, trackId: "audio0")
        audioTrack = track
        pc.add(track, streamIds: ["stream0"])
        // 视频轨在后续任务补
    }

    // 通话音频会话:playAndRecord + voiceChat 模式(启回声消除/自动增益,默认走听筒)。
    // 用 libwebrtc 的 RTCAudioSession(它内部与 WebRTC 音频单元共享同一实例,避免与其抢占配置);
    // 配置期加锁、结束解锁,isAudioEnabled 打开让 WebRTC 接管播放/录制。
    private func configureAudioSession() {
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        defer { session.unlockForConfiguration() }
        do {
            try session.setCategory(.playAndRecord, with: [.allowBluetooth])
            try session.setMode(.voiceChat)
            try session.setActive(true)
            session.isAudioEnabled = true
        } catch {
            // 配置失败不致命(极少见,如被系统中断):放行,后续通话可能静音但不崩。
        }
    }

    func setSpeaker(_ on: Bool) {
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        defer { session.unlockForConfiguration() }
        // 免提走扬声器,否则回听筒;仅 playAndRecord 生效。
        try? session.overrideOutputAudioPort(on ? .speaker : .none)
    }

    func createOffer() async throws -> SessionDescriptionDTO {
        guard let pc else { throw WebRTCError.noPeerConnection }
        let sdpText = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<String, Error>) in
            pc.offer(for: Self.sendRecvConstraints) { sdp, error in
                // 只把 Sendable 的 SDP 字符串越过 continuation 边界,非 Sendable 的
                // RTCSessionDescription 不逃逸;回到 actor 内再重建并设为 localDescription。
                if let sdp { cont.resume(returning: sdp.sdp) }
                else { cont.resume(throwing: error ?? WebRTCError.sdpFailed) }
            }
        }
        try await setLocal(pc, RTCSessionDescription(type: .offer, sdp: sdpText))
        return SessionDescriptionDTO(type: "offer", sdp: sdpText)
    }

    func createAnswer(remoteOffer: SessionDescriptionDTO) async throws -> SessionDescriptionDTO {
        guard let pc else { throw WebRTCError.noPeerConnection }
        try await setRemote(pc, RTCSessionDescription(type: .offer, sdp: remoteOffer.sdp))
        drainPending()
        let sdpText = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<String, Error>) in
            pc.answer(for: Self.sendRecvConstraints) { sdp, error in
                if let sdp { cont.resume(returning: sdp.sdp) }
                else { cont.resume(throwing: error ?? WebRTCError.sdpFailed) }
            }
        }
        try await setLocal(pc, RTCSessionDescription(type: .answer, sdp: sdpText))
        return SessionDescriptionDTO(type: "answer", sdp: sdpText)
    }

    func setRemoteAnswer(_ answer: SessionDescriptionDTO) async throws {
        guard let pc else { throw WebRTCError.noPeerConnection }
        try await setRemote(pc, RTCSessionDescription(type: .answer, sdp: answer.sdp))
        drainPending()
    }

    func addRemoteCandidate(_ dto: IceCandidateDTO) {
        let hasRemote = pc?.remoteDescription != nil
        guard let ready = candidateBuffer.add(dto, remoteDescriptionSet: hasRemote) else { return }
        applyCandidate(ready)
    }

    private func applyCandidate(_ dto: IceCandidateDTO) {
        guard let pc else { return }
        let candidate = RTCIceCandidate(
            sdp: dto.candidate,
            sdpMLineIndex: Int32(dto.sdpMlineIndex ?? 0),
            sdpMid: dto.sdpMid
        )
        pc.add(candidate) { _ in }
    }

    private func drainPending() {
        for dto in candidateBuffer.drain() { applyCandidate(dto) }
    }

    func setMuted(_ muted: Bool) {
        audioTrack?.isEnabled = !muted
    }

    func reset() {
        pc?.close()
        pc = nil
        buildPC()
        // buffer 内容保留:重建后 remoteDescription 尚未设置,早到候选仍需等待补投。
    }

    func close() {
        pc?.close()
        pc = nil
        for c in subscribers.values { c.finish() }
        subscribers.removeAll()
        deactivateAudioSession()
    }

    // 通话结束释放音频会话:关 isAudioEnabled 并停用,让系统把音频路由/焦点交还其它 App。
    private func deactivateAudioSession() {
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        defer { session.unlockForConfiguration() }
        session.isAudioEnabled = false
        try? session.setActive(false)
    }

    private func ingest(_ event: WebRTCEvent) {
        for c in subscribers.values { c.yield(event) }
    }

    // 把 setLocalDescription 的 completion-handler 形态包成 async。
    private func setLocal(_ pc: RTCPeerConnection, _ sdp: RTCSessionDescription) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            pc.setLocalDescription(sdp) { error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            }
        }
    }

    // 把 setRemoteDescription 的 completion-handler 形态包成 async。
    private func setRemote(_ pc: RTCPeerConnection, _ sdp: RTCSessionDescription) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            pc.setRemoteDescription(sdp) { error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            }
        }
    }
}

enum WebRTCError: Error {
    case noPeerConnection
    case sdpFailed
}

// delegate 只经由 @Sendable sink 把 RTC 回调转成 Sendable 事件转发;RTC 类型不越界。
// sink 由 RTCEngine.init 通过 attach 一次性注入(在任何 PeerConnection 存在之前),
// 之后只读不写,故 @unchecked Sendable 成立、信令线程上的回调读 sink 无竞争。
final class PCDelegate: NSObject, RTCPeerConnectionDelegate, @unchecked Sendable {
    private var sink: (@Sendable (WebRTCEvent) -> Void)?

    func attach(_ sink: @escaping @Sendable (WebRTCEvent) -> Void) {
        self.sink = sink
    }

    func peerConnection(_: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        sink?(.localCandidate(IceCandidateDTO(
            candidate: candidate.sdp,
            sdpMlineIndex: Int(candidate.sdpMLineIndex),
            sdpMid: candidate.sdpMid
        )))
    }

    func peerConnection(_: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        let name: String
        switch newState {
        case .connected: name = "connected"
        case .failed: name = "failed"
        case .closed: name = "closed"
        default: name = "other"
        }
        sink?(.connectionState(name))
    }

    func peerConnection(_: RTCPeerConnection, didAdd receiver: RTCRtpReceiver, streams _: [RTCMediaStream]) {
        if receiver.track?.kind == "video" { sink?(.remoteVideoAvailable) }
    }

    // 其余 RTCPeerConnectionDelegate 必须实现的方法留空,满足协议要求以通过编译。
    func peerConnection(_: RTCPeerConnection, didChange _: RTCSignalingState) {}
    func peerConnection(_: RTCPeerConnection, didAdd _: RTCMediaStream) {}
    func peerConnection(_: RTCPeerConnection, didRemove _: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_: RTCPeerConnection) {}
    func peerConnection(_: RTCPeerConnection, didChange _: RTCIceConnectionState) {}
    func peerConnection(_: RTCPeerConnection, didChange _: RTCIceGatheringState) {}
    func peerConnection(_: RTCPeerConnection, didRemove _: [RTCIceCandidate]) {}
    func peerConnection(_: RTCPeerConnection, didOpen _: RTCDataChannel) {}
}
